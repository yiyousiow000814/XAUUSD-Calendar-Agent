!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove only the app-specific roaming folder on uninstall (never during update).
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    IfFileExists "$APPDATA\XAUUSDCalendar\.xauusdcalendar.marker" 0 +2
      RmDir /r "$APPDATA\XAUUSDCalendar"
  ${EndIf}
!macroend

