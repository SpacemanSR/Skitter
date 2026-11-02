; Skitter installer — per-user, no admin prompt. Built with native makensis (no Wine needed):
;   makensis -DSRC=<win-unpacked dir> -DVERSION=0.2.0 -DOUTFILE=<setup.exe> -DICON=<icon.ico> installer.nsi
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "Skitter"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Skitter"
InstallDirRegKey HKCU "Software\Skitter" "InstallDir"
BrandingText "Skitter ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Skitter"
VIAddVersionKey "FileDescription" "Skitter Setup"
VIAddVersionKey "CompanyName" "Mr. Interactive"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Mr. Interactive"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Meet Skitter"
!define MUI_WELCOMEPAGE_TEXT "A little yellow robot who lives on the edge of your screen and fetches the file you were about to go looking for.$\r$\n$\r$\nHe reads your Documents, Desktop and Downloads folders on this computer only. Nothing is uploaded.$\r$\n$\r$\nClick Install to put him to work."
!define MUI_FINISHPAGE_RUN "$INSTDIR\Skitter.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Skitter now"
!define MUI_FINISHPAGE_TITLE "Skitter is installed"
!define MUI_FINISHPAGE_TEXT "He'll appear on a shelf at the right edge of your screen. Click him to send him for something; right-click him for settings."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Skitter"

Section "Skitter" SecMain
  SectionIn RO
  ; close a running copy so files can be replaced
  nsExec::Exec 'taskkill /IM Skitter.exe /F'
  nsExec::Exec 'taskkill /IM Gofer.exe /F'
  Sleep 600
  ; Skitter used to be called Gofer: remove the old copy (its data is carried over on first launch)
  IfFileExists "$LOCALAPPDATA\Programs\Gofer\Uninstall Gofer.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\Programs\Gofer\Uninstall Gofer.exe" /S'
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources\app"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Skitter.exe"

  CreateShortCut "$SMPROGRAMS\Skitter.lnk" "$INSTDIR\Skitter.exe" "" "$INSTDIR\Skitter.exe" 0
  CreateShortCut "$DESKTOP\Skitter.lnk" "$INSTDIR\Skitter.exe" "" "$INSTDIR\Skitter.exe" 0

  WriteRegStr HKCU "Software\Skitter" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Skitter"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Mr. Interactive"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Skitter.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall Skitter.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Skitter.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM Skitter.exe /F'
  Sleep 600
  Delete "$SMPROGRAMS\Skitter.lnk"
  Delete "$DESKTOP\Skitter.lnk"
  ; stop starting with Windows (Electron registers the app under one of these names)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Skitter"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Skitter"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.mrinteractive.gofer"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Skitter"
  RMDir /r "$INSTDIR"
  ; your index, settings and fetch history stay in %APPDATA%\Skitter unless you delete that folder
SectionEnd
