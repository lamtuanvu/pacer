# Built-in terminal

Open **Terminal** from Pacer's side rail, or press `g` then `t`. Choose a workspace or enter an absolute working folder, then select **New terminal**. The shell opens in a tab and keeps running when you leave the page or close the app window. You can rename and close tabs, split the view between two tabs, and search terminal output. Closing a running tab asks for confirmation and stops its process.

Pacer settings actions that need an interactive shell open their own terminal tab in the app. The same terminal record reconnects after a reload. Task sessions remain on their task page, where their live viewer and control actions are available.

Terminal management requires a local authenticated Pacer session. A terminal is local to the machine running `pacer serve`; opening a configured SSH host starts SSH inside a Pacer tab. The CLI and TUI still support explicit external terminal targets.
