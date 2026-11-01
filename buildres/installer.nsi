; Gofer installer — per-user, no admin prompt. Built with native makensis (no Wine needed):
;   makensis -DSRC=<win-unpacked dir> -DVERSION=0.2.0 -DOUTFILE=<setup.exe> -DICON=<icon.ico> installer.nsi
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "Gofer"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Gofer"
InstallDirRegKey HKCU "Software\Gofer" "InstallDir"
BrandingText "Gofer ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Gofer"
VIAddVersionKey "FileDescription" "Gofer Setup"
VIAddVersionKey "CompanyName" "Mr. Interactive"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Mr. Interactive"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Meet Gofer"
!define MUI_WELCOMEPAGE_TEXT "A little yellow robot who lives on the edge of your screen and fetches the file you were about to go looking for.$\r$\n$\r$\nHe reads your Documents, Desktop and Downloads folders on this computer only. Nothing is uploaded.$\r$\n$\r$\nClick Install to put him to work."
!define MUI_FINISHPAGE_RUN "$INSTDIR\Gofer.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Gofer now"
!define MUI_FINISHPAGE_TITLE "Gofer is installed"
!define MUI_FINISHPAGE_TEXT "He'll appear on a shelf at the right edge of your screen. Click him to send him for something; right-click him for settings."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gofer"

Section "Gofer" SecMain
  SectionIn RO
  ; close a running copy so files can be replaced
  nsExec::Exec 'taskkill /IM Gofer.exe /F'
  Sleep 600
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources\app"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Gofer.exe"

  CreateShortCut "$SMPROGRAMS\Gofer.lnk" "$INSTDIR\Gofer.exe" "" "$INSTDIR\Gofer.exe" 0
  CreateShortCut "$DESKTOP\Gofer.lnk" "$INSTDIR\Gofer.exe" "" "$INSTDIR\Gofer.exe" 0

  WriteRegStr HKCU "Software\Gofer" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Gofer"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Mr. Interactive"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Gofer.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall Gofer.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Gofer.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM Gofer.exe /F'
  Sleep 600
  Delete "$SMPROGRAMS\Gofer.lnk"
  Delete "$DESKTOP\Gofer.lnk"
  ; stop starting with Windows (Electron registers the app under one of these names)
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Gofer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Gofer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.mrinteractive.gofer"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Gofer"
  RMDir /r "$INSTDIR"
  ; your index, settings and fetch history stay in %APPDATA%\Gofer unless you delete that folder
SectionEnd
