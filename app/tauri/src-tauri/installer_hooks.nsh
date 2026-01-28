!macro NSIS_HOOK_POSTINSTALL
  ; Move bundled seed data out of `resources/` into install root `data/` so the user sees:
  ;   <install_dir>\data\Economic_Calendar\...
  ;   <install_dir>\data\event_history_index\...
  ; and does not see `resources/` after install.
  CreateDirectory "$INSTDIR\data"

  ; Copy recursively (hidden, no cmd window).
  nsExec::ExecToLog 'cmd /c xcopy /E /I /Y "$INSTDIR\resources\seed-repo\data\*" "$INSTDIR\data\"'

  ; Remove resources folder to match legacy layout expectations.
  RMDir /r "$INSTDIR\resources\seed-repo"
  RMDir /r "$INSTDIR\resources"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Ensure portable folders are removed on uninstall.
  RMDir /r "$INSTDIR\user-data"
  RMDir /r "$INSTDIR\data"
!macroend

