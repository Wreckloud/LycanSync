!include LogicLib.nsh
!include WordFunc.nsh
!include nsDialogs.nsh
!include "${BUILD_RESOURCES_DIR}\installer-files.nsh"

!ifndef BUILD_UNINSTALLER
  Var lycanDesktopShortcut
  Var lycanDesktopShortcutCheckbox

  !macro customInit
    StrCpy $lycanDesktopShortcut "1"
    ; 手动与静默升级都保留用户取消或删除的快捷方式。
    SetRegView 64
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" ShortcutName
    ${If} $0 != ""
    ${AndIf} $1 != ""
    ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      ${IfNot} ${FileExists} "$DESKTOP\$1.lnk"
        StrCpy $lycanDesktopShortcut "0"
      ${EndIf}
    ${EndIf}
  !macroend
!endif

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
  !define MUI_WELCOMEPAGE_TEXT "此向导将安装 LycanSync。$\r$\n$\r$\n升级请沿用原安装目录，data 中的账号与设置会保留。$\r$\n$\r$\n单击“下一步”继续。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW LycanWelcomeOptionsShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE LycanWelcomeOptionsLeave
  !insertmacro MUI_PAGE_WELCOME

  Function LycanWelcomeOptionsShow
    ${NSD_CreateCheckbox} 120u 165u 195u 14u "创建桌面快捷方式"
    Pop $lycanDesktopShortcutCheckbox
    SetCtlColors $lycanDesktopShortcutCheckbox "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${NSD_SetState} $lycanDesktopShortcutCheckbox $lycanDesktopShortcut
  FunctionEnd

  Function LycanWelcomeOptionsLeave
    ${NSD_GetState} $lycanDesktopShortcutCheckbox $lycanDesktopShortcut
  FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
!include "${BUILD_RESOURCES_DIR}\installer-runtime.nsh"
Function EnsureVisualCppRuntime
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  StrCpy $1 $1 "" 1
  ${VersionCompare} $1 "${LYCAN_BUNDLED_VC_RUNTIME_VERSION}" $2
  ${If} $0 == 1
  ${AndIf} $2 != 2
    Return
  ${EndIf}
  SetDetailsPrint textonly
  DetailPrint "正在安装 Microsoft Visual C++ 运行库…"
  SetDetailsPrint lastused
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
  ${VersionCompare} $1 "${LYCAN_BUNDLED_VC_RUNTIME_VERSION}" $2
  ${If} $0 != 1
  ${OrIf} $2 == 2
    MessageBox MB_OK|MB_ICONSTOP "未检测到所需运行库，安装未完成。请查看微软安装程序的提示后重试。" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Function CleanInstallationPayloads
  SetDetailsPrint textonly
  DetailPrint "正在清理安装临时文件…"
  SetOutPath "$INSTDIR"
  ClearErrors
  ${If} ${FileExists} "$PLUGINSDIR\vc_redist.x64.exe"
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
  ${EndIf}
  !ifdef COMPRESSION_METHOD
    ${If} ${FileExists} "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
      Delete "$PLUGINSDIR\app-64.${COMPRESSION_METHOD}"
    ${EndIf}
  !endif
  ${If} ${Errors}
    DetailPrint "部分临时文件将在安装器退出时继续清理。"
  ${EndIf}
  ClearErrors
  SetDetailsPrint lastused
FunctionEnd
!endif

!macro customInstall
  WriteRegStr HKCU "Software\Classes\lycansync" "" "URL:LycanSync"
  WriteRegStr HKCU "Software\Classes\lycansync" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\lycansync\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  Call FinishApplicationReplacement
  Call CleanInstallationPayloads
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
