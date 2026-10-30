# Records docs/demo.gif: a dry run for a sample help desk SaaS (docs/demo/*.yml).
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

# The briefing goes to a file, so it can be paged from the top: the terminal would only keep the end.
Type "clear && pochi run --dry-run > briefing.txt"
Sleep 300ms
Enter
# The log lines and the first moments of the wait, then the rest of the wait is cut.
Sleep 5s
Hide
Wait
Show

Type "clear && more briefing.txt"
Sleep 300ms
Enter
Sleep 7s
Space
Sleep 6s
Space
Sleep 6s
