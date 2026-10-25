!include LogicLib.nsh
!include WordFunc.nsh
!include "${BUILD_RESOURCES_DIR}\installer-files.nsh"

!macro LycanCheckEntry NAME KIND
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${NAME}") i .r2'
    IntOp $2 $2 & 0x400
    ${If} $2 != 0
      MessageBox MB_OK|MB_ICONSTOP "程序路径包含链接，已停止操作；请保留 data 并核对安装目录。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro LycanDeleteEntry NAME KIND
  ${If} ${FileExists} "$INSTDIR\${NAME}"
  !if "${KIND}" == "directory"
    RMDir /r "$INSTDIR\${NAME}"
  !else
    Delete "$INSTDIR\${NAME}"
  !endif
  ${EndIf}
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!ifndef BUILD_UNINSTALLER
Function EnsureVisualCppRuntime
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  StrCpy $1 $1 "" 1
  ${VersionCompare} $1 "14.44.35211.0" $2
  ${If} $0 == 1
  ${AndIf} $2 != 2
    Return
  ${EndIf}
  DetailPrint "正在安装 Microsoft Visual C++ 运行库…"
  InitPluginsDir
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ClearErrors
  ExecShellWait "runas" "$PLUGINSDIR\vc_redist.x64.exe" "/install /passive /norestart" SW_SHOWNORMAL
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "运行库安装未完成，请允许微软安装程序运行后重试。" /SD IDOK
    Abort
  ${EndIf}
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  StrCpy $1 $1 "" 1
  ${VersionCompare} $1 "14.44.35211.0" $2
  ${If} $0 != 1
  ${OrIf} $2 == 2
    MessageBox MB_OK|MB_ICONSTOP "未检测到所需运行库，安装未完成。请查看微软安装程序的提示后重试。" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  WriteRegStr HKCU "Software\Classes\lycansync" "" "URL:LycanSync"
  WriteRegStr HKCU "Software\Classes\lycansync" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\lycansync\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  Call FinishApplicationReplacement
!macroend

!macro customRemoveFiles
  ; 永远不递归清理安装根目录；data 内的凭据、配置和正在运行的更新包不属于程序文件。
  !insertmacro LycanApplicationEntries LycanCheckEntry
  ClearErrors
  !insertmacro LycanApplicationEntries LycanDeleteEntry
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "部分程序文件仍被占用，卸载未完成。请退出 LycanSync 后重试；data 已保留。" /SD IDOK
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\lycansync\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\lycansync"
  ${EndIf}
  SetOutPath $TEMP
  RMDir "$INSTDIR"
!macroend
