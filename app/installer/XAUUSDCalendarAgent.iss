; XAUUSD Calendar Agent installer

#define MyAppName "XAUUSD Calendar Agent"
#define MyAppDirName "XAUUSDCalendarAgent"
#define MyAppExeName "XAUUSD Calendar Agent.exe"
; Version is injected by `scripts/build_installer.ps1` from `app/agent/version.py`.
#ifndef MyAppVersion
#define MyAppVersion "0.0.0"
#endif
#define MyPublisher "XAUUSD"

[Setup]
AppId={{3F6B2F3A-2A0F-4A93-9C5D-7E1D1C7F7D0E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
DefaultDirName={localappdata}\{#MyAppDirName}
DefaultGroupName={#MyAppName}
OutputDir=..\..
OutputBaseFilename=Setup
SetupIconFile=..\assets\setup_installer.ico
WizardStyle=modern
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons"

[Files]
Source: "..\..\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\data\Economic_Calendar\*"; DestDir: "{app}\data\Economic_Calendar"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove any runtime-created files/folders inside the install directory (e.g. user_data),
; without maintaining per-folder delete lists.
Type: filesandordirs; Name: "{app}\*"
Type: dirifempty; Name: "{app}"
Type: filesandordirs; Name: "{userappdata}\XAUUSDCalendar"

[Code]
// Ensure uninstall can remove the installed binary even if the app is still running.
function IsProcessRunningByImageName(const ImageName: string): Boolean;
var
  ResultCode: Integer;
  TaskListOut: string;
  Contents: AnsiString;
begin
  Result := False;
  TaskListOut := ExpandConstant('{tmp}\xauusd_tasklist.txt');

  Exec(
    ExpandConstant('{cmd}'),
    '/C tasklist /FI "IMAGENAME eq ' + ImageName + '" /NH > "' + TaskListOut + '"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );

  if ResultCode <> 0 then begin
    Log('tasklist failed with code ' + IntToStr(ResultCode));
    Exit;
  end;

  if (not LoadStringFromFile(TaskListOut, Contents)) then begin
    Log('Failed to read tasklist output: ' + TaskListOut);
    Exit;
  end;

  Result := Pos(Lowercase(ImageName), Lowercase(string(Contents))) > 0;
end;

procedure ForceCloseAppForUninstall();
var
  ResultCode: Integer;
  ImageName: string;
  Attempt: Integer;
begin
  ImageName := ExpandConstant('{#MyAppExeName}');

  if not IsProcessRunningByImageName(ImageName) then begin
    Exit;
  end;

  Exec(
    ExpandConstant('{sys}\taskkill.exe'),
    '/F /IM "' + ImageName + '" /T',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );

  if ResultCode <> 0 then begin
    Log('taskkill failed with code ' + IntToStr(ResultCode));
  end;

  for Attempt := 1 to 30 do begin
    if not IsProcessRunningByImageName(ImageName) then begin
      Exit;
    end;
    Sleep(500);
  end;

  MsgBox(
    'Uninstall cannot continue because "' + ImageName + '" is still running.' + #13#10 +
    'Please close it and try again.',
    mbError,
    MB_OK
  );
  Abort;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    ForceCloseAppForUninstall();
  end;
end;
