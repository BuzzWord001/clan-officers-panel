Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' Запускаем start_bot.bat скрытно — в нём цикл, который перезапускает Python при коде выхода 42.
WshShell.Run "cmd /c start_bot.bat", 0, False
