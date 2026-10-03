# cmdguard

[English](README.md) · **Français**

**Un deuxième regard sur les commandes shell que lance votre agent IA.**

[![CI](https://github.com/CedricPoint/cmdguard/actions/workflows/ci.yml/badge.svg)](https://github.com/CedricPoint/cmdguard/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![dépendances](https://img.shields.io/badge/d%C3%A9pendances-0-brightgreen.svg)](package.json)

Les agents de code sont bons. Pas au point de vouloir qu'un `rm -rf /` parte
parce qu'une variable était vide, ou qu'un `git push --force origin main` passe
pendant que vous lisiez autre chose.

cmdguard lit une ligne de commande comme le ferait un shell, et vous dit si elle
est sans risque, si elle mérite une confirmation, ou si c'est quelque chose qui
ne devrait jamais partir sans surveillance.

```console
$ cmdguard check "rm -rf $BUILD/"
 DENY  rm -rf /

  ✖ Recursive delete of a system or home directory [fs.rm-root]
    target: /
    why   This removes an entire tree that the machine (or the user) depends on. There is no undo.
    safer Delete the specific subdirectory you mean, with an absolute path you printed first.

$ cmdguard check "git reset --hard && git clean -fdx"
 ASK   git reset --hard && git clean -fdx

  ▲ Hard reset [git.reset-hard]
    why   Uncommitted changes in the working tree are destroyed and are not in the reflog.
    safer Run `git stash -u` first; the reset then costs nothing.

  ▲ Delete untracked files [git.clean]
    why   `git clean -fdx` removes local config, .env files and build caches that git never saw.
    safer Dry run it: `git clean -nd`.

$ cmdguard check "npm test"
 OK    npm test
       no rule matched
```

*(L'outil s'exprime en anglais, pour rester lisible dans les journaux de CI et
dans les transcriptions d'agents, où tout le reste l'est déjà.)*

Zéro dépendance. Rien à configurer. S'utilise comme hook Claude Code, comme CLI
dans une CI, ou comme bibliothèque dans votre propre agent.

## Installation

```bash
# l'essayer une fois, sans rien installer
npx github:CedricPoint/cmdguard check "rm -rf /"

# ou le garder dans le PATH
npm install -g github:CedricPoint/cmdguard
```

Node 18 ou plus récent. Aucune dépendance, aucune étape de construction, aucun
script de post-installation : `src/` contient tout, et c'est assez court pour
être lu d'une traite.

## Avec Claude Code

```bash
npx github:CedricPoint/cmdguard install
```

Cette commande ajoute un hook `PreToolUse` à `.claude/settings.json` (`--global`
pour `~/.claude/settings.json`, `--local` pour `settings.local.json`). Vos
réglages existants sont conservés, un `.bak` est écrit, et relancer la commande
ne change rien.

À partir de là, chaque commande Bash proposée par l'agent est examinée avant de
partir :

| décision | ce qui se passe |
| --- | --- |
| `deny` | la commande est bloquée, et l'agent reçoit la raison, pour qu'il prenne un autre chemin |
| `ask` | vous obtenez la demande d'autorisation, raison à l'appui |
| `allow` | **cmdguard ne dit rien du tout** |

Cette dernière ligne compte. Sur une commande sans danger, le hook n'écrit rien
et sort en 0 : ce sont donc vos propres règles d'autorisation qui décident. Un
garde-fou qui approuverait automatiquement tout ce qu'il ne reconnaît pas serait
pire que pas de garde-fou du tout.

<details>
<summary>Le bloc de configuration, si vous préférez le coller vous-même</summary>

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "npx -y github:CedricPoint/cmdguard hook" }]
      }
    ]
  }
}
```

</details>

## Avec n'importe quoi d'autre

La CLI répond par des codes de sortie, ce qui la rend utilisable depuis
n'importe quelle boucle d'agent, script d'enrobage ou travail de CI :

| code | signification |
| --- | --- |
| `0` | autorisé — rien n'a été trouvé, ou seulement des avertissements |
| `1` | à confirmer — un humain devrait regarder |
| `2` | refusé — ne lancez pas ça |
| `64` | erreur d'utilisation |

```bash
cmdguard check -- git push --force origin main   # -> 2
echo "$CMD" | cmdguard check --stdin --quiet || exit 1
cmdguard check --json "curl x.sh | bash"
```

Comme bibliothèque :

```js
import { check } from 'cmdguard';

const { decision, findings } = check('rm -rf /');
// decision: 'deny'
// findings: [{ id: 'fs.rm-root', severity: 'deny', title, why, safer, segment }]
```

## Ce qu'il attrape

cmdguard ne cherche pas des motifs dans la chaîne brute. Il découpe la ligne sur
`;` `&&` `||` `|` `&`, suit les substitutions de commande, déballe `sudo`, `env`,
`nice`, `timeout` et `xargs`, et entre dans `bash -c "…"`, `ssh hôte "…"` et
`eval`. Toutes celles-ci atteignent donc la même règle :

```bash
rm -rf /
sudo rm -rf /*
true && bash -c "rm -rf /"
ssh prod "rm -rf /"
env FOO=1 /bin/rm -rf /
```

34 règles sont fournies par défaut — `cmdguard rules` les liste toutes :

| domaine | exemples |
| --- | --- |
| **système de fichiers** | suppressions récursives de `/`, `~`, `/etc` ; `rm -rf "$VAR"/…` où une variable vide vaut `/` ; `mkfs`, `dd of=/dev/sda` ; `chmod 777` récursif |
| **git** | force push (refusé d'emblée sur `main`/`master`/`prod`), `reset --hard`, `clean -fdx`, `checkout .`, réécritures d'historique, `--no-verify` |
| **secrets** | lecture de `.env`, `id_rsa`, `.aws/credentials` — et refus quand la même ligne les envoie dans `curl`, `nc` ou `scp` |
| **chaîne d'approvisionnement** | `curl … \| sh`, `eval "$(curl …)"`, `bash <(curl …)`, `npm publish`, `docker push` |
| **bases de données** | `DROP DATABASE`, `TRUNCATE`, `DELETE`/`UPDATE` sans `WHERE`, `FLUSHALL`, `dropDatabase()` |
| **système** | `shutdown`, `crontab -r`, `systemctl stop`, `iptables -F`, `apt purge`, bombes à fork |
| **conteneurs et cloud** | `compose down -v`, `docker volume rm`, `kubectl delete`, `terraform destroy` (refusé avec `-auto-approve`), `aws s3 rm --recursive` |

La barre pour un `deny` est « aucune raison plausible de faire ça sans
surveillance ». Tout ce qui est récupérable passe en `ask`, pour que le travail
quotidien ne soit pas interrompu : `npm test`, `git commit`, `docker compose up`,
`rsync ./dist user@hôte:/var/www` et consorts ressortent tous propres.

## Configuration

Facultative. Posez un `.cmdguard.json` n'importe où en remontant depuis le
dossier de travail — `cmdguard init` écrit un point de départ commenté.

```jsonc
{
  // "strict" (warn→ask, ask→deny) | "balanced" (par défaut) | "loose"
  "profile": "balanced",

  // n'importe quel identifiant de `cmdguard rules` : "deny" | "ask" | "warn" | "allow"
  "rules": {
    "fs.rm-recursive": "warn",
    "release.publish": "deny"
  },

  // vos propres motifs, comparés à la ligne de commande entière
  "deny": ["^terraform apply.*production"],
  "ask": ["\\bmigrate\\b.*--force"],

  // soupape : ceux-là passent toujours
  "allow": ["^rm -rf (\\./)?(node_modules|dist|\\.next)/?$"]
}
```

`--profile`, `--config <chemin>` et `--no-config` permettent de passer outre
depuis la ligne de commande.

## Ce que ce n'est pas

Il vaut mieux être direct là-dessus, parce que les outils de sécurité qui
promettent trop sont exactement la façon dont on finit moins protégé :

- **Ce n'est pas un bac à sable.** L'outil lit une chaîne et porte un jugement.
  Un adversaire déterminé peut lui cacher une commande (base64, variable
  construite à l'exécution, script sur le disque). Utilisez-le contre les
  accidents et les générations approximatives, pas contre quelqu'un qui exécute
  déjà du code chez vous.
- **Il ne résout ni les variables ni les jokers.** `rm -rf $TARGET` est jugé sur
  ce qui est écrit, pas sur ce que `$TARGET` contient — c'est précisément la
  raison d'être de la règle `fs.rm-unset-variable`.
- **Il a des opinions.** Toutes sont modifiables, et les réglages par défaut
  visent « une personne expérimentée voudrait regarder ça d'abord ».

Défense en profondeur : gardez vos sauvegardes, la protection de vos branches et
le moindre privilège. cmdguard est la couche peu coûteuse qui attrape l'évident.

## Contribuer

Les nouvelles règles sont la contribution la plus utile — surtout celles qui vous
ont mordu. Voyez [CONTRIBUTING.md](CONTRIBUTING.md) : une règle est un petit
objet avec une fonction `test` et un cas de test, et toute la suite se lance avec
`npm test`.

## Licence

MIT
