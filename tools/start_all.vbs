' Тихий запуск start_all.bat без видимого консольного окна.
' Используется в shell:startup для автостарта при логине Windows.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c start_all.bat", 0, False
