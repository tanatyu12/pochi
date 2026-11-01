# Updating Pochi

Pochi is not on npm, so you update your copy of the repository with git. Releases are tagged `vX.Y.Z` on [github.com/tanatyu12/pochi](https://github.com/tanatyu12/pochi/releases), and each one lists its changes in `CHANGELOG.md`.

Before 1.0, a minor release (0.**2**.0) may change the config, the state file or a command. Read the release notes before you update across one; a patch release (0.1.**1**) only fixes things.

Your own files do not get in the way: `config/*.yml`, `.env`, `reports/` and `logs/` are ignored by git, and `state/notified.json` and `.github/workflows/daily_briefing.yml` exist only in your copy.

## A clone

```sh
git fetch origin --tags
git merge v0.2.0          # or: git pull, for the latest commit on main
```

## A copy made with "Use this template"

A template copy starts with its own history, so git does not know it came from Pochi. Add Pochi as a second remote once:

```sh
git remote add upstream https://github.com/tanatyu12/pochi
git fetch upstream --tags
# First time only: join the two histories. On files both sides have, Pochi's version wins;
# files only you have (the workflow, the state file) are kept.
git merge v0.2.0 --allow-unrelated-histories -X theirs
```

Files Pochi deleted after your copy was made are not deleted by this first merge; `git diff --stat v0.2.0` lists everything that differs from the release, which should be only your own files. From then on, `git fetch upstream --tags && git merge v0.3.0` is enough.

## After merging

```sh
npm ci && npm run build
pochi doctor                 # checks the config against the new version
pochi schedule status        # warns when the installed job no longer matches
pochi schedule install       # again, with the same --backend, if the job or workflow changed
```

On GitHub Actions the workflow builds Pochi on every run, so only `pochi schedule install --backend github` (when the release notes mention the workflow), a commit and a push are needed.

Your copy also carries the files Pochi's own repository uses: `ci.yml` runs the tests on your pushes, and `.github/dependabot.yml` opens dependency updates in your repository. Delete either if you do not want it; `release-please.yml` does nothing outside Pochi's repository.
