# -----------------------------------------------------------------------------
#  Native Windows dialog for choosing a file or a folder.
#
#  ATTENTION: this file is intentionally written in Latin characters only.
#  Windows PowerShell 5.1 reads .ps1 in the ANSI codepage, so Cyrillic without
#  a BOM turns into garbage. All Cyrillic texts (dialog title, filter) are
#  passed as command line arguments, and the chosen path is written to a UTF-8
#  file - not to stdout, where the console codepage would break it.
# -----------------------------------------------------------------------------

param(
    [string]$Mode = 'folder',
    [string]$OutputFile = '',
    [string]$Title = '',
    [string]$Filter = '',
    [string]$Initial = '',
    [string]$FileName = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

$picked = ''

# A hidden topmost form is used as the dialog owner, otherwise the dialog can
# open behind the browser window and look like the application has hung.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.WindowState = 'Minimized'
$owner.Show()
$owner.Activate()

try {
    if ($Mode -eq 'file') {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        if ($Title)  { $dialog.Title = $Title }
        if ($Filter) { $dialog.Filter = $Filter }
        $dialog.CheckFileExists = $true
        $dialog.Multiselect = $false
        if ($Initial) {
            $dir = $Initial
            if (Test-Path -LiteralPath $dir -PathType Leaf) { $dir = Split-Path -Parent $dir }
            if (Test-Path -LiteralPath $dir -PathType Container) { $dialog.InitialDirectory = $dir }
        }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $picked = $dialog.FileName
        }
    }
    elseif ($Mode -eq 'save') {
        # "Save as" dialog: used by the "download report" command. The report is
        # written by the server, so the dialog only returns the chosen path.
        $dialog = New-Object System.Windows.Forms.SaveFileDialog
        if ($Title)  { $dialog.Title = $Title }
        if ($Filter) { $dialog.Filter = $Filter }
        if ($FileName) { $dialog.FileName = $FileName }
        $dialog.OverwritePrompt = $true
        $dialog.AddExtension = $true
        if ($Initial -and (Test-Path -LiteralPath $Initial -PathType Container)) {
            $dialog.InitialDirectory = $Initial
        }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $picked = $dialog.FileName
        }
    }
    else {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        if ($Title) { $dialog.Description = $Title }
        $dialog.ShowNewFolderButton = $true
        if ($Initial -and (Test-Path -LiteralPath $Initial -PathType Container)) {
            $dialog.SelectedPath = $Initial
        }
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
            $picked = $dialog.SelectedPath
        }
    }
}
finally {
    $owner.Close()
    $owner.Dispose()
}

if ($OutputFile) {
    [System.IO.File]::WriteAllText($OutputFile, $picked, (New-Object System.Text.UTF8Encoding($true)))
}
