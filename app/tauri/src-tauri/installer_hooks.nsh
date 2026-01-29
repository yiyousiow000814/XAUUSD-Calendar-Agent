!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove only the app-specific roaming folder on uninstall (never during update).
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\XAUUSDCalendar"
  ${EndIf}
!macroend

