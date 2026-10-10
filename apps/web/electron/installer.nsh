!include LogicLib.nsh
!include WordFunc.nsh

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
    MessageBox MB_OK|MB_ICONSTOP "运行库安装未完成，请允许微软安装程序运行后重试。"
    Abort
  ${EndIf}
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  StrCpy $1 $1 "" 1
  ${VersionCompare} $1 "14.44.35211.0" $2
  ${If} $0 != 1
  ${OrIf} $2 == 2
    MessageBox MB_OK|MB_ICONSTOP "未检测到所需运行库，安装未完成。请查看微软安装程序的提示后重试。"
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  Call EnsureVisualCppRuntime
!macroend
