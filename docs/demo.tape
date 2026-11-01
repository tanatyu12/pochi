# Records docs/demo.gif for the README with vhs (brew install vhs):
#
#   npm run build && vhs docs/demo.tape
#
# Run it in a copy with config/context.yml and config/sources.yml. The dry run calls the LLM
# (billed as a normal run) but posts nothing and leaves the state file alone.

Output docs/demo.gif

Set Shell zsh
Set FontSize 16
Set Width 1100
Set Height 680
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Hide
Type "alias pochi='node dist/pochi.mjs' && clear"
Enter
Show

Type "pochi woof"
Enter
Sleep 2.5s

Type "pochi doctor"
Enter
Sleep 4s

Type "clear && pochi run --dry-run"
Enter
# Long enough for the LLM; trim the wait in the GIF afterwards if it drags.
Sleep 90s
