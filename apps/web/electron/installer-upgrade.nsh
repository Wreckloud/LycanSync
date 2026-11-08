; 只替换程序清单；不执行历史卸载器，不移动 data 或从中运行的安装包。

!macro LycanRejectProtectedDirectory ROOT
  GetFullPathName $1 "${ROOT}"
  StrCpy $1 "$1\"
  StrLen $2 $1
  StrCpy $3 $0 $2
  ${If} $3 == $1
    MessageBox MB_OK|MB_ICONSTOP "LycanSync 将数据保存在安装目录内，不能安装到 Program Files 或 Windows 等系统目录。请选择当前用户可写的目录，例如 D:\Programs\LycanSync。已有 data 请保留，不要删除。" /SD IDOK
    Abort
  ${EndIf}
!macroend

Function EnsureUserInstallLocation
  GetFullPathName $0 "$INSTDIR"
  StrCpy $0 "$0\"
  !insertmacro LycanRejectProtectedDirectory "$PROGRAMFILES64"
  !insertmacro LycanRejectProtectedDirectory "$PROGRAMFILES32"
  !insertmacro LycanRejectProtectedDirectory "$WINDIR"
FunctionEnd

Var lycanReplacementPrepared
Var lycanReplacementPending
Var lycanReplacementFailure
Var lycanBackupRoot

Function WriteReplacementState
  ClearErrors
  FileOpen $1 "$lycanBackupRoot\state" w
  FileWrite $1 "$0"
  FileClose $1
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法保存升级恢复信息，升级已停止。请保留 data 和 .lycan-update-backup 文件夹。" /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

!macro LycanStageEntry NAME KIND
  ${If} $lycanReplacementFailure == ""
  ${AndIf} ${FileExists} "$INSTDIR\${NAME}"
    ClearErrors
    Rename "$INSTDIR\${NAME}" "$lycanBackupRoot\${NAME}"
    ${If} ${Errors}
      StrCpy $lycanReplacementFailure "${NAME}"
    ${EndIf}
  ${EndIf}
!macroend

!macro LycanRestoreEntry NAME KIND
  ${If} ${FileExists} "$lycanBackupRoot\${NAME}"
    ClearErrors
    !insertmacro LycanDeleteEntry "${NAME}" ${KIND}
    ${If} ${Errors}
      StrCpy $lycanReplacementFailure "${NAME}"
    ${Else}
      ; 保留原暂存到全部恢复成功，重复恢复不能误删上次已还原的文件。
      CopyFiles /SILENT "$lycanBackupRoot\${NAME}" "$INSTDIR"
      ${If} ${Errors}
        StrCpy $lycanReplacementFailure "${NAME}"
      ${EndIf}
    ${EndIf}
  ${ElseIf} $lycanReplacementPrepared == "1"
    ClearErrors
    !insertmacro LycanDeleteEntry "${NAME}" ${KIND}
    ${If} ${Errors}
      StrCpy $lycanReplacementFailure "${NAME}"
    ${EndIf}
  ${EndIf}
!macroend

Function RestoreApplicationReplacement
  ${If} $lycanReplacementPending != "1"
    Return
  ${EndIf}
  StrCpy $lycanReplacementFailure ""
  !insertmacro LycanApplicationEntries LycanRestoreEntry
  SetOutPath "$INSTDIR"
  ${If} $lycanReplacementFailure == ""
    RMDir /r "$lycanBackupRoot"
    StrCpy $lycanReplacementPending "0"
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "旧版程序未能完整恢复，请保留 $lycanBackupRoot 和 data 文件夹，不要卸载或删除目录。" /SD IDOK
  ${EndIf}
FunctionEnd

Function PrepareApplicationReplacement
  Call EnsureUserInstallLocation
  ${If} $lycanReplacementPrepared == "1"
    ClearErrors
    StrCpy $R0 0
    Return
  ${EndIf}
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 == ""
    ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $0 != ""
      !insertmacro GetInQuotes $0 "$0"
      Push $0
      Call GetFileParent
      Pop $0
    ${EndIf}
  ${EndIf}
  ${If} $0 != ""
    GetFullPathName $0 "$0"
    GetFullPathName $1 "$INSTDIR"
    ${If} $0 != $1
      MessageBox MB_OK|MB_ICONSTOP "已有安装，请选择原安装目录升级。迁移目录前请先备份 data。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  Push $INSTDIR
  Call GetFileParent
  Pop $1
  ${If} $1 == ""
    Abort
  ${EndIf}
  GetFullPathName $2 "$INSTDIR"
  GetFullPathName $3 "$INSTDIR\.."
  ${If} $2 == $3
    Abort
  ${EndIf}
  Call EnsureVisualCppRuntime
  !insertmacro LycanApplicationEntries LycanCheckEntry
  StrCpy $lycanBackupRoot "$INSTDIR\.lycan-update-backup"
  ${If} ${FileExists} "$lycanBackupRoot"
    ClearErrors
    FileOpen $1 "$lycanBackupRoot\state" r
    FileRead $1 $0
    FileClose $1
    ${If} ${Errors}
      StrCpy $0 ""
    ${EndIf}
    ${If} $0 == "committed"
      SetOutPath "$INSTDIR"
      RMDir /r "$lycanBackupRoot"
    ${ElseIf} $0 == "preparing"
    ${OrIf} $0 == "staged"
      StrCpy $lycanReplacementPending "1"
      StrCpy $lycanReplacementPrepared "0"
      ${If} $0 == "staged"
        StrCpy $lycanReplacementPrepared "1"
      ${EndIf}
      Call RestoreApplicationReplacement
    ${EndIf}
    ${If} ${FileExists} "$lycanBackupRoot"
      MessageBox MB_OK|MB_ICONSTOP "上次升级的备份未能恢复，请保留 .lycan-update-backup 和 data 文件夹，暂时不要卸载。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  ClearErrors
  CreateDirectory "$lycanBackupRoot"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "无法准备升级文件，旧程序尚未替换。请检查目录权限和磁盘空间。" /SD IDOK
    Abort
  ${EndIf}
  SetErrorLevel 2
  StrCpy $0 "preparing"
  Call WriteReplacementState
  StrCpy $lycanReplacementPrepared "0"
  StrCpy $lycanReplacementPending "1"
  StrCpy $lycanReplacementFailure ""
  !insertmacro LycanApplicationEntries LycanStageEntry
  ${If} $lycanReplacementFailure != ""
    DetailPrint "程序文件仍被占用：$lycanReplacementFailure"
    Call RestoreApplicationReplacement
    MessageBox MB_OK|MB_ICONSTOP "程序文件仍被占用或无法移动，升级已停止。请完全退出 lycanclaw 后重试，不要删除 data 文件夹。" /SD IDOK
    Abort
  ${EndIf}
  StrCpy $0 "staged"
  Call WriteReplacementState
  StrCpy $lycanReplacementPrepared "1"
  ClearErrors
  StrCpy $R0 0
FunctionEnd

Function FinishApplicationReplacement
  StrCpy $0 "committed"
  Call WriteReplacementState
  StrCpy $lycanReplacementPending "0"
  SetErrorLevel 0
  ${If} $lycanReplacementPrepared == "1"
    SetDetailsPrint textonly
    DetailPrint "正在清理旧程序暂存…"
    SetOutPath "$INSTDIR"
    RMDir /r "$lycanBackupRoot"
    ${If} ${FileExists} "$lycanBackupRoot"
      MessageBox MB_OK|MB_ICONEXCLAMATION "新版已安装，但旧版备份未能清理。请保留 data 文件夹，并在下次升级前处理 .lycan-update-backup。" /SD IDOK
    ${EndIf}
    SetDetailsPrint lastused
  ${EndIf}
FunctionEnd

Function .onInstFailed
  Call RestoreApplicationReplacement
FunctionEnd

Function .onGUIEnd
  Call RestoreApplicationReplacement
FunctionEnd
