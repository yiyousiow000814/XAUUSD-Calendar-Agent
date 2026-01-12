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
OutputDir=..
OutputBaseFilename=Setup
SetupIconFile=..\app\assets\setup_installer.ico
WizardStyle=modern
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons"

[Files]
Source: "..\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\data\Economic_Calendar\*"; DestDir: "{app}\data\Economic_Calendar"; Flags: ignoreversion recursesubdirs createallsubdirs

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
