# Local connector, step 1: read-only export from the Hashavshevet SQL Server database to JSON files.
# Runs every .sql file in .\queries and writes <name>.json to -OutDir.
# It only ever sends SELECT statements, uses READ UNCOMMITTED so it never blocks Hashavshevet users,
# and connects with the Windows identity of whoever runs it (no password is stored anywhere).
param(
    [Parameter(Mandatory = $true)][string]$ConnectionString,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string[]]$Only
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Data
Add-Type -AssemblyName System.Web.Extensions

$queriesDir = Join-Path $PSScriptRoot "queries"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue
$utf8 = New-Object System.Text.UTF8Encoding $false

$connection = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
$connection.Open()
try {
    $setup = $connection.CreateCommand()
    $setup.CommandText = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET NOCOUNT ON;"
    [void]$setup.ExecuteNonQuery()

    foreach ($file in Get-ChildItem $queriesDir -Filter *.sql | Sort-Object Name) {
        $name = $file.BaseName
        if ($Only -and ($Only -notcontains $name)) { continue }
        $sql = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
        # Defence in depth: refuse anything that is not a plain read.
        $body = ($sql -replace "(?m)--.*$", "")
        if ($body -match "(?i)\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke)\b") {
            throw "Query file $($file.Name) contains a statement that is not a read."
        }
        $command = $connection.CreateCommand()
        $command.CommandText = $sql
        $command.CommandTimeout = 120
        $reader = $command.ExecuteReader()
        $rows = New-Object System.Collections.Generic.List[object]
        try {
            while ($reader.Read()) {
                $row = New-Object 'System.Collections.Generic.Dictionary[string,object]'
                for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                    $value = $reader.GetValue($i)
                    if ($value -is [DBNull]) { $value = $null }
                    elseif ($value -is [datetime]) { $value = $value.ToString("yyyy-MM-dd") }
                    elseif ($value -is [string]) { $value = $value.Trim() }
                    $row[$reader.GetName($i)] = $value
                }
                $rows.Add($row)
            }
        } finally { $reader.Close() }
        [IO.File]::WriteAllText((Join-Path $OutDir "$name.json"), $serializer.Serialize($rows), $utf8)
        Write-Output "$name=$($rows.Count)"
    }
} finally {
    $connection.Close()
}
