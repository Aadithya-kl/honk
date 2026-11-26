# Records the demo on the website. Run from the repo root:
#   bun run record-demo
# It uses `honk --demo`: made-up networks and people, no IRC traffic.

Output site/demo.mp4
Output site/demo.webm

Set Shell bash
Set FontSize 16
Set Width 1400
Set Height 820
Set Padding 0
Set Framerate 30
Set TypingSpeed 70ms
Set Theme "TokyoNight"
Set WindowBar Colorful
Set BorderRadius 10

# Start honk off camera. The demo's timeline starts with it.
Hide
Type "clear && bun run src/index.tsx --demo"
Enter
Sleep 3s
Show

# The channel, with the unread divider and a highlighted mention.
Sleep 1s
# The still image for the page, shown before the video plays or with reduced motion.
Screenshot site/demo.png
Sleep 2s

# Tab completes a nick. Someone answers.
Type "mal"
Sleep 400ms
Tab
Sleep 400ms
Type "the omnibox is my favorite part"
Sleep 300ms
Enter
Sleep 2.5s

# The omnibox: jump to #bun by typing part of its name.
Ctrl+K
Sleep 800ms
Type "bun"
Sleep 700ms
Enter
Sleep 2.5s

# A DM from mallard has arrived (red badge). Open it with the omnibox's @ mode.
Ctrl+K
Sleep 500ms
Type "@mall"
Sleep 900ms
Enter
Sleep 1s
Type "sure, what's up?"
Sleep 300ms
Enter
Sleep 2.5s

# An action, with /me.
Type "/me honks back"
Sleep 300ms
Enter
Sleep 2s

# The command list: / in the omnibox.
Ctrl+K
Sleep 500ms
Type "/"
Sleep 1.8s
Escape
Sleep 500ms

# Back to #honk, where the conversation goes on.
Ctrl+K
Sleep 500ms
Type "honk"
Sleep 600ms
Enter
Sleep 2.5s

# Hide the channel list, for narrow terminals, then show it again.
Ctrl+B
Sleep 1.5s
Ctrl+B
Sleep 3s

Hide
Ctrl+C
