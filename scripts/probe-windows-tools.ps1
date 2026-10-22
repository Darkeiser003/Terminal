$ErrorActionPreference = 'Continue'

# Sonda independiente del builder. No instala ni modifica nada: recarga el
# PATH del usuario, localiza las rutas fijas de NSudo y ejecuta exactamente las
# comprobaciones CLI que exige la batería ampliada de Windows.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$env:Path = "$userPath;$machinePath"

$probes = @(
    @{ Name = 'cmd'; Exe = $env:ComSpec; Args = @('/d', '/c', 'exit 0') },
    @{ Name = 'PowerShell'; Exe = 'powershell.exe'; Args = @('-NoProfile', '-NonInteractive', '-Command', 'exit 0') },
    @{ Name = 'PowerShell 7'; Exe = 'pwsh'; Args = @('-NoProfile', '-NonInteractive', '-Command', 'exit 0') },
    @{ Name = 'Nushell'; Exe = 'nu'; Args = @('--version') },
    @{ Name = 'Windows Terminal'; Exe = 'wt.exe'; DetectOnly = $true },
    @{ Name = 'NSudo'; Exe = 'C:\WSCore\Components\Hooks\NSudo\NSudoLC.exe'; Args = @('-?') },
    @{ Name = 'Node.js'; Exe = 'node'; Args = @('-e', 'process.exit(0)') },
    @{ Name = 'npm'; Exe = 'npm'; Args = @('--version') },
    @{ Name = 'Git'; Exe = 'git'; Args = @('--version') },
    @{ Name = 'Python'; Exe = 'python'; Args = @('-I', '-c', "print('LTERMINAL_REPL_OK')"); Expect = 'LTERMINAL_REPL_OK' },
    @{ Name = 'Ruby'; Exe = 'ruby'; Args = @('-e', "puts 'LTERMINAL_REPL_OK'"); Expect = 'LTERMINAL_REPL_OK' },
    @{ Name = 'PHP'; Exe = 'php'; Args = @('-r', "echo 'LTERMINAL_REPL_OK';"); Expect = 'LTERMINAL_REPL_OK' },
    @{ Name = 'MariaDB'; Exe = 'mariadb'; Args = @('--version') },
    @{ Name = 'MySQL'; Exe = 'mysql'; Args = @('--version') },
    @{ Name = 'PostgreSQL'; Exe = 'psql'; Args = @('--version') },
    @{ Name = 'Kotlin'; Exe = 'kotlinc'; Args = @('-version') },
    @{ Name = 'Dart'; Exe = 'dart'; Args = @('--version') },
    @{ Name = 'Zig'; Exe = 'zig'; Args = @('version') },
    @{ Name = 'Swift'; Exe = 'swift'; Args = @('--version') },
    @{ Name = 'MongoDB Shell'; Exe = 'mongosh'; Args = @('--version') },
    @{ Name = 'Redis CLI'; Exe = 'redis-cli'; Args = @('--version') },
    @{ Name = 'Rust/Cargo'; Exe = 'cargo'; Args = @('--version') },
    @{ Name = 'Rustc'; Exe = 'rustc'; Args = @('--version') },
    @{ Name = 'Java'; Exe = 'java'; Args = @('-version') },
    @{ Name = 'Go'; Exe = 'go'; Args = @('version') },
    @{ Name = 'Perl'; Exe = 'perl'; Args = @('-e', 'print qq(LTERMINAL_REPL_OK`n)'); Expect = 'LTERMINAL_REPL_OK' },
    @{ Name = 'Lua'; Exe = 'lua'; Args = @('-e', "print('LTERMINAL_REPL_OK')"); Expect = 'LTERMINAL_REPL_OK' },
    @{ Name = 'Deno'; Exe = 'deno'; Args = @('--version') },
    @{ Name = 'Bun'; Exe = 'bun'; Args = @('--version') },
    @{ Name = 'Julia'; Exe = 'julia'; Args = @('--version') },
    @{ Name = 'R'; Exe = 'R.exe'; Args = @('--version') },
    @{ Name = '.NET'; Exe = 'dotnet'; Args = @('--info') },
    @{ Name = 'Clang'; Exe = 'clang'; Args = @('--version') },
    @{ Name = 'CMake'; Exe = 'cmake'; Args = @('--version') },
    @{ Name = 'Maven'; Exe = 'mvn'; Args = @('--version') },
    @{ Name = 'Gradle'; Exe = 'gradle'; Args = @('--version') },
    @{ Name = 'Ant'; Exe = 'ant'; Args = @('-version') },
    @{ Name = 'Bazel'; Exe = 'bazel'; Args = @('--version') },
    @{ Name = 'Ninja'; Exe = 'ninja'; Args = @('--version') },
    @{ Name = 'Meson'; Exe = 'meson'; Args = @('--version') },
    @{ Name = 'GDB'; Exe = 'gdb'; Args = @('--version') },
    @{ Name = 'Groovy'; Exe = 'groovysh'; Args = @('--version') },
    @{ Name = 'SQLite'; Exe = 'sqlite3'; Args = @('--version') },
    @{ Name = 'jq'; Exe = 'jq'; Args = @('--version') },
    @{ Name = 'yq'; Exe = 'yq'; Args = @('--version') },
    @{ Name = 'Docker'; Exe = 'docker'; Args = @('--version') },
    @{ Name = 'kubectl'; Exe = 'kubectl'; Args = @('version', '--client=true') },
    @{ Name = 'Helm'; Exe = 'helm'; Args = @('version', '--short') },
    @{ Name = 'k9s'; Exe = 'k9s'; Args = @('version', '--short') },
    @{ Name = 'OpenVPN'; Exe = 'openvpn'; Args = @('--version') },
    @{ Name = 'WireGuard'; Exe = 'wg.exe'; Args = @('--version') },
    @{ Name = 'Tailscale'; Exe = 'tailscale'; Args = @('version') },
    @{ Name = 'QEMU'; Exe = 'qemu-system-x86_64'; Args = @('--version') },
    @{ Name = 'VirtualBox'; Exe = 'VBoxManage.exe'; Args = @('--version') }
)

$missing = [System.Collections.Generic.List[string]]::new()
$failed = [System.Collections.Generic.List[string]]::new()
$passed = [System.Collections.Generic.List[string]]::new()
foreach ($probe in $probes) {
    $resolved = $null
    if (Test-Path -LiteralPath $probe.Exe -PathType Leaf) {
        $resolved = $probe.Exe
    } else {
        $resolved = (Get-Command $probe.Exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    }
    if (-not $resolved) {
        $patterns = switch ($probe.Name) {
            'MariaDB' { @('C:\Program Files\MariaDB*\bin\mariadb.exe', 'C:\Program Files (x86)\MariaDB*\bin\mariadb.exe') }
            'Julia' { @((Join-Path $env:LOCALAPPDATA 'Programs\Julia-*\bin\julia.exe'), 'C:\Julia*\bin\julia.exe', 'C:\Program Files\Julia*\bin\julia.exe') }
            'R' { @('C:\Program Files\R\R-*\bin\x64\R.exe', 'C:\Program Files\R\R-*\bin\R.exe', 'C:\Program Files (x86)\R\R-*\bin\R.exe') }
            'OpenVPN' { @('C:\Program Files\OpenVPN\bin\openvpn.exe', 'C:\Program Files (x86)\OpenVPN\bin\openvpn.exe') }
            'QEMU' { @('C:\Program Files\qemu\qemu-system-x86_64.exe', 'C:\Program Files\QEMU\qemu-system-x86_64.exe') }
            'VirtualBox' { @('C:\Program Files\Oracle\VirtualBox\VBoxManage.exe', 'C:\Program Files (x86)\Oracle\VirtualBox\VBoxManage.exe') }
            default { @() }
        }
        foreach ($pattern in $patterns) {
            $candidate = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($candidate) { $resolved = $candidate.FullName; break }
        }
    }
    if (-not $resolved) { $missing.Add($probe.Name); continue }
    if ($probe.DetectOnly) { $passed.Add($probe.Name); continue }
    $output = (& $resolved @($probe.Args) 2>&1 | Out-String)
    $code = $LASTEXITCODE
    if ($code -ne 0 -or ($probe.Expect -and $output -notmatch [regex]::Escape($probe.Expect))) {
        $failed.Add("$($probe.Name) [$code]")
    } else {
        $passed.Add($probe.Name)
    }
}

$result = [pscustomobject]@{
    total = $probes.Count
    passed = $passed.Count
    missing = @($missing)
    failed = @($failed)
    passedNames = @($passed)
}
$result | ConvertTo-Json -Depth 5
if ($missing.Count -gt 0 -or $failed.Count -gt 0) { exit 1 }
