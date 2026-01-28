!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's NSIS template deletes $APPDATA\$BUNDLEID when "Delete app data" is checked.
  ; Our app stores data under $APPDATA\XAUUSDCalendar, so mirror that behavior.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\XAUUSDCalendar"
  ${EndIf}
!macroend

