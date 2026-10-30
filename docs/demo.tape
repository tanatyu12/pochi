# Records docs/demo.gif: Pochi briefing on what Pochi itself is built on (docs/demo/*.yml).
# Run `npm run demo`, which runs this in Docker; see scripts/demo.sh.

Output docs/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
# The dry run waits on the LLM.
Set WaitTimeout 5m

# A scratch directory with the demo config, so the commands shown need no flags.
Hide
Type `export DEMO=$(mktemp -d) && mkdir $DEMO/config && cp docs/demo/*.yml $DEMO/config/`
Enter
Type `alias pochi="node $PWD/dist/pochi.mjs" && cd $DEMO && clear`
Enter
Show

Type "pochi woof"
Sleep 300ms
Enter
Wait
Sleep 2s

Type "clear && pochi doctor"
Sleep 300ms
Enter
Wait
Sleep 4s

Type "clear && pochi run --dry-run"
Sleep 300ms
Enter
Wait
Sleep 8s
