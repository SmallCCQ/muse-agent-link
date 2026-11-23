Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd.exe /c """ & CreateObject("WScript.Shell").ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\muse-agent-link\run-daemon.cmd""", 0, False
