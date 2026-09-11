# Fixed, source-only helper. JSON stdin is data, never PowerShell source.
# No desktop capture, focus changes, camera actions, external compiler, or generated executable.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$culture = [System.Globalization.CultureInfo]::InvariantCulture
[System.Threading.Thread]::CurrentThread.CurrentCulture = $culture
[System.Threading.Thread]::CurrentThread.CurrentUICulture = $culture

function Unavailable([string]$Reason) { return @{ status = 'unavailable'; reason = $Reason } }
function NotRequested { return @{ status = 'not-requested'; reason = 'not-requested' } }
function Fail([string]$Reason) { throw (New-Object System.InvalidOperationException($Reason)) }

function Initialize-Native {
    # Reflection.Emit creates only a run-only in-memory assembly. Add-Type -TypeDefinition
    # would launch a compiler on Windows PowerShell and is deliberately not used.
    $name = New-Object System.Reflection.AssemblyName('PotassiumGameContextNative')
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('Native')
    $type = $module.DefineType('PotassiumGameContextWindow', [System.Reflection.TypeAttributes]'Public,Abstract,Sealed')
    $specs = @(
        @{ name = 'SetThreadDpiAwarenessContext'; result = [IntPtr]; args = [Type[]]@([IntPtr]) },
        @{ name = 'GetTopWindow'; result = [IntPtr]; args = [Type[]]@([IntPtr]) },
        @{ name = 'GetWindow'; result = [IntPtr]; args = [Type[]]@([IntPtr], [uint32]) },
        @{ name = 'IsWindow'; result = [int]; args = [Type[]]@([IntPtr]) },
        @{ name = 'IsWindowVisible'; result = [int]; args = [Type[]]@([IntPtr]) },
        @{ name = 'IsIconic'; result = [int]; args = [Type[]]@([IntPtr]) },
        @{ name = 'GetClientRect'; result = [int]; args = [Type[]]@([IntPtr], [int[]]); out = 2 },
        @{ name = 'GetWindowThreadProcessId'; result = [uint32]; args = [Type[]]@([IntPtr], [uint32[]]); out = 2 },
        @{ name = 'PrintWindow'; result = [int]; args = [Type[]]@([IntPtr], [IntPtr], [uint32]) }
    )
    foreach ($spec in $specs) {
        $method = $type.DefinePInvokeMethod($spec.name, 'user32.dll',
            [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
            [System.Reflection.CallingConventions]::Standard, $spec.result, $spec.args,
            [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Auto)
        $method.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
        if ($spec.ContainsKey('out')) { $null = $method.DefineParameter($spec.out, [System.Reflection.ParameterAttributes]::Out, 'value') }
    }
    $script:native = $type.CreateType()
    # Resolve native client dimensions in physical pixels without changing the target window.
    if ($script:native::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { Fail 'target-unavailable' }
}

function Window-Owner([IntPtr]$Handle) {
    $owner = New-Object 'uint32[]' 1
    if ($script:native::GetWindowThreadProcessId($Handle, $owner) -eq 0) { Fail 'target-changed' }
    return $owner[0]
}

function Window-Size([IntPtr]$Handle) {
    $rect = New-Object 'int[]' 4
    if ($script:native::GetClientRect($Handle, $rect) -eq 0) { Fail 'target-unavailable' }
    $width = $rect[2] - $rect[0]
    $height = $rect[3] - $rect[1]
    if ($width -lt 240 -or $height -lt 160 -or $width -gt 8192 -or $height -gt 8192 -or ([long]$width * $height) -gt 32000000) { Fail 'window-size-limit' }
    return @{ width = $width; height = $height }
}

function Get-Target {
    $processes = @([System.Diagnostics.Process]::GetProcessesByName('RobloxPlayerBeta'))
    try {
        if ($processes.Count -eq 0) { Fail 'target-not-found' }
        # Even an additional hidden/minimized Roblox process makes association ambiguous.
        if ($processes.Count -ne 1) { Fail 'target-ambiguous' }
        $process = $processes[0]
        $process.Refresh()
        if ($process.HasExited) { Fail 'target-changed' }
        $processId = $process.Id
        $started = $process.StartTime.ToUniversalTime()
        $main = $process.MainWindowHandle
        if ($main -eq [IntPtr]::Zero -or $script:native::IsWindowVisible($main) -eq 0 -or $script:native::IsIconic($main) -ne 0) { Fail 'target-not-visible' }
        if ($script:native::IsWindow($main) -eq 0 -or (Window-Owner $main) -ne $processId) { Fail 'target-changed' }
        # Enumerate only window metadata. No titles, executable paths, or user identities.
        $handle = $script:native::GetTopWindow([IntPtr]::Zero)
        $seen = New-Object 'System.Collections.Generic.HashSet[long]'
        $suitable = New-Object 'System.Collections.Generic.List[long]'
        while ($handle -ne [IntPtr]::Zero) {
            if ($seen.Count -ge 4096 -or -not $seen.Add($handle.ToInt64())) { Fail 'target-unavailable' }
            $owner = New-Object 'uint32[]' 1
            $thread = $script:native::GetWindowThreadProcessId($handle, $owner)
            if ($thread -ne 0 -and $owner[0] -eq $processId -and $script:native::IsWindowVisible($handle) -ne 0 -and $script:native::IsIconic($handle) -eq 0 -and $script:native::GetWindow($handle, 4) -eq [IntPtr]::Zero) {
                $suitable.Add($handle.ToInt64())
                if ($suitable.Count -gt 1) { Fail 'target-ambiguous' }
            }
            $handle = $script:native::GetWindow($handle, 2)
        }
        if ($suitable.Count -ne 1 -or $suitable[0] -ne $main.ToInt64()) { Fail 'target-unavailable' }
        $size = Window-Size $main
        return @{ pid = $processId; startedAt = $started.ToString('o', $culture); ticks = $started.Ticks; handle = $main; width = $size.width; height = $size.height }
    } finally {
        foreach ($process in $processes) { $process.Dispose() }
    }
}

function Assert-SameTarget($Before, $After) {
    if ($Before.pid -ne $After.pid -or $Before.ticks -ne $After.ticks -or $Before.handle -ne $After.handle -or $Before.width -ne $After.width -or $Before.height -ne $After.height) { Fail 'target-changed' }
}

function Assert-Nonuniform($Bitmap) {
    # Fixed <=4096 samples. A highly uniform result is unavailable, never replaced with pixels.
    $minimum = @(255, 255, 255)
    $maximum = @(0, 0, 0)
    $buckets = @{}
    $samples = 0
    $dominant = 0
    $stepX = [Math]::Max(1, [int][Math]::Ceiling($Bitmap.Width / 64.0))
    $stepY = [Math]::Max(1, [int][Math]::Ceiling($Bitmap.Height / 64.0))
    for ($y = 0; $y -lt $Bitmap.Height; $y += $stepY) {
        for ($x = 0; $x -lt $Bitmap.Width; $x += $stepX) {
            $color = $Bitmap.GetPixel($x, $y)
            $channels = @([int]$color.R, [int]$color.G, [int]$color.B)
            for ($i = 0; $i -lt 3; $i++) {
                $minimum[$i] = [Math]::Min($minimum[$i], $channels[$i])
                $maximum[$i] = [Math]::Max($maximum[$i], $channels[$i])
            }
            $key = (($channels[0] -shr 4) -shl 8) -bor (($channels[1] -shr 4) -shl 4) -bor ($channels[2] -shr 4)
            $count = 1
            if ($buckets.ContainsKey($key)) { $count += $buckets[$key] }
            $buckets[$key] = $count
            $dominant = [Math]::Max($dominant, $count)
            $samples++
        }
    }
    $range = [Math]::Max($maximum[0] - $minimum[0], [Math]::Max($maximum[1] - $minimum[1], $maximum[2] - $minimum[2]))
    if ($range -le 8 -or $dominant -ge $samples * 0.995) { Fail 'capture-uniform' }
}

function Encode-Jpeg($Source, [int]$MaxBytes, [int]$MaxDimension, [int]$MinWidth, [int]$MinHeight, [string]$Provider) {
    $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if ($null -eq $encoder) { Fail 'helper-unavailable' }
    $ratio = [Math]::Min(1.0, $MaxDimension / [double][Math]::Max($Source.Width, $Source.Height))
    $width = [int][Math]::Floor($Source.Width * $ratio)
    $height = [int][Math]::Floor($Source.Height * $ratio)
    for ($attempt = 0; $attempt -lt 9 -and $width -ge $MinWidth -and $height -ge $MinHeight; $attempt++) {
        $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $graphics = $null
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($Source, 0, 0, $width, $height)
            $graphics.Dispose()
            $graphics = $null
            foreach ($quality in @(85, 65, 45, 30)) {
                $stream = New-Object System.IO.MemoryStream
                $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
                try {
                    $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
                    $bitmap.Save($stream, $encoder, $parameters)
                    if ($stream.Length -le $MaxBytes) {
                        return @{ status = 'available'; data = [Convert]::ToBase64String($stream.ToArray()); mimeType = 'image/jpeg'; width = $width; height = $height; provider = $Provider }
                    }
                } finally { $parameters.Dispose(); $stream.Dispose() }
            }
        } finally {
            if ($null -ne $graphics) { $graphics.Dispose() }
            $bitmap.Dispose()
        }
        $width = [int][Math]::Floor($width * 0.8)
        $height = [int][Math]::Floor($height * 0.8)
    }
    Fail 'image-budget'
}

function Capture-Window([int]$MaxBytes) {
    $bitmap = $null
    $graphics = $null
    try {
        Initialize-Native
        $before = Get-Target
        $bitmap = New-Object System.Drawing.Bitmap($before.width, $before.height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $dc = $graphics.GetHdc()
        try {
            # PW_CLIENTONLY | PW_RENDERFULLCONTENT: request the target window's own render.
            # There is deliberately no BitBlt, CopyFromScreen, desktop, or other fallback.
            $captured = $script:native::PrintWindow($before.handle, $dc, 3)
        } finally { $graphics.ReleaseHdc($dc) }
        $graphics.Dispose()
        $graphics = $null
        Assert-SameTarget $before (Get-Target)
        if ($captured -eq 0) { Fail 'capture-failed' }
        Assert-Nonuniform $bitmap
        $result = Encode-Jpeg $bitmap $MaxBytes 1600 240 160 'windows-printwindow-client-area'
        # Reject process replacement, window ownership/visibility changes, or resize during encoding too.
        Assert-SameTarget $before (Get-Target)
        $result.target = @{ pid = $before.pid; startedAt = $before.startedAt; windowHandle = ('0x' + $before.handle.ToInt64().ToString('x', $culture)) }
        return $result
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function Finite-Number($Value, [double]$Maximum, [bool]$Positive = $false) {
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [string]) { Fail 'invalid-scene' }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or [Math]::Abs($number) -gt $Maximum -or ($Positive -and $number -le 0)) { Fail 'invalid-scene' }
    return $number
}

function Scene-Boxes($Scene) {
    if ($null -eq $Scene -or $Scene.parts -isnot [Array] -or $Scene.parts.Count -gt 512) { Fail 'invalid-scene' }
    $boxes = New-Object 'System.Collections.Generic.List[object]'
    foreach ($part in $Scene.parts) {
        if ($part.name -isnot [string] -or $part.name.Length -gt 80 -or $part.cframe -isnot [Array] -or $part.cframe.Count -ne 12) { Fail 'invalid-scene' }
        $cf = New-Object 'double[]' 12
        for ($i = 0; $i -lt 12; $i++) { $cf[$i] = Finite-Number $part.cframe[$i] $(if ($i -lt 3) { 1e9 } else { 1.001 }) }
        $half = @(((Finite-Number $part.size.x 1e6 $true) / 2), ((Finite-Number $part.size.y 1e6 $true) / 2), ((Finite-Number $part.size.z 1e6 $true) / 2))
        # CFrame's full 3x3 rotation transforms all eight box corners. Pitch/roll matter:
        # the projected convex hull is not an axis-aligned or yaw-only approximation.
        $corners = New-Object 'System.Collections.Generic.List[object]'
        foreach ($sx in @(-1, 1)) {
            foreach ($sy in @(-1, 1)) {
                foreach ($sz in @(-1, 1)) {
                    $x = $cf[0] + $cf[3] * $half[0] * $sx + $cf[4] * $half[1] * $sy + $cf[5] * $half[2] * $sz
                    $z = $cf[2] + $cf[9] * $half[0] * $sx + $cf[10] * $half[1] * $sy + $cf[11] * $half[2] * $sz
                    $corners.Add(@{ x = $x; z = $z })
                }
            }
        }
        $boxes.Add(@{ name = $part.name; x = $cf[0]; z = $cf[2]; y = $cf[1]; corners = $corners.ToArray() })
    }
    return ,$boxes.ToArray()
}

function Cross($A, $B, $C) { return ($B.x - $A.x) * ($C.z - $A.z) - ($B.z - $A.z) * ($C.x - $A.x) }
function Hull($Points) {
    $sorted = @($Points | Sort-Object -Property @{ Expression = { $_.x } }, @{ Expression = { $_.z } } -Unique)
    if ($sorted.Count -lt 3) { return ,$sorted }
    $lower = New-Object 'System.Collections.Generic.List[object]'
    foreach ($point in $sorted) {
        while ($lower.Count -ge 2 -and (Cross $lower[$lower.Count - 2] $lower[$lower.Count - 1] $point) -le 0) { $lower.RemoveAt($lower.Count - 1) }
        $lower.Add($point)
    }
    $upper = New-Object 'System.Collections.Generic.List[object]'
    for ($i = $sorted.Count - 1; $i -ge 0; $i--) {
        $point = $sorted[$i]
        while ($upper.Count -ge 2 -and (Cross $upper[$upper.Count - 2] $upper[$upper.Count - 1] $point) -le 0) { $upper.RemoveAt($upper.Count - 1) }
        $upper.Add($point)
    }
    $lower.RemoveAt($lower.Count - 1)
    $upper.RemoveAt($upper.Count - 1)
    return ,@($lower.ToArray() + $upper.ToArray())
}

function Map-Image($Scene, [int]$MaxBytes) {
    $boxes = Scene-Boxes $Scene
    $player = $null
    if ($null -ne $Scene.player) {
        $player = @{ x = (Finite-Number $Scene.player.x 1e9); y = (Finite-Number $Scene.player.y 1e9); z = (Finite-Number $Scene.player.z 1e9) }
    }
    if ($boxes.Count -eq 0 -and $null -eq $player) { Fail 'map-empty' }
    $minX = [double]::PositiveInfinity; $maxX = [double]::NegativeInfinity
    $minZ = [double]::PositiveInfinity; $maxZ = [double]::NegativeInfinity
    foreach ($box in $boxes) {
        foreach ($point in $box.corners) {
            $minX = [Math]::Min($minX, $point.x); $maxX = [Math]::Max($maxX, $point.x)
            $minZ = [Math]::Min($minZ, $point.z); $maxZ = [Math]::Max($maxZ, $point.z)
        }
    }
    if ($null -ne $player) {
        $minX = [Math]::Min($minX, $player.x); $maxX = [Math]::Max($maxX, $player.x)
        $minZ = [Math]::Min($minZ, $player.z); $maxZ = [Math]::Max($maxZ, $player.z)
    }
    $spanX = [Math]::Max(20, $maxX - $minX); $spanZ = [Math]::Max(20, $maxZ - $minZ)
    $centerX = ($minX + $maxX) / 2; $centerZ = ($minZ + $maxZ) / 2
    $scale = [Math]::Min(820.0 / $spanX, 460.0 / $spanZ)
    $leftX = $centerX - 430 / $scale; $topZ = $centerZ - 245 / $scale
    $bitmap = New-Object System.Drawing.Bitmap(960, 720, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $resources = New-Object 'System.Collections.Generic.List[System.IDisposable]'
    try {
        $g = [System.Drawing.Graphics]::FromImage($bitmap); $resources.Add($g)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::FromArgb(245, 247, 248))
        $font = New-Object System.Drawing.Font('Segoe UI', 11); $resources.Add($font)
        $title = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold); $resources.Add($title)
        $small = New-Object System.Drawing.Font('Segoe UI', 9); $resources.Add($small)
        $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(24, 40, 50)); $resources.Add($ink)
        $muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 89, 100)); $resources.Add($muted)
        $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 137, 171, 187)); $resources.Add($fill)
        $red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(185, 45, 36)); $resources.Add($red)
        $outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(67, 102, 122), 1); $resources.Add($outline)
        $grid = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(218, 226, 230), 1); $resources.Add($grid)
        $axis = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(100, 119, 130), 1.5); $resources.Add($axis)
        $g.DrawString('SCHEMATIC - CLIENT-VISIBLE BOXES', $title, $ink, [single]30, [single]20)
        $g.DrawString(('Top-down X/Z projection | {0} observed boxes | Y height collapsed' -f $boxes.Count), $font, $muted, [single]30, [single]55)
        $g.SetClip((New-Object System.Drawing.Rectangle(50, 100, 860, 490)))
        $rawStep = [Math]::Max($spanX, $spanZ) / 8
        $power = [Math]::Pow(10, [Math]::Floor([Math]::Log10($rawStep)))
        $normalized = $rawStep / $power
        $multiplier = if ($normalized -le 1) { 1 } elseif ($normalized -le 2) { 2 } elseif ($normalized -le 5) { 5 } else { 10 }
        $step = $power * $multiplier
        $firstX = [Math]::Ceiling($leftX / $step) * $step
        $firstZ = [Math]::Ceiling($topZ / $step) * $step
        for ($i = 0; $i -lt 24; $i++) {
            $worldX = $firstX + $i * $step; $x = [single](50 + ($worldX - $leftX) * $scale)
            if ($x -gt 910) { break }
            $g.DrawLine($grid, $x, [single]100, $x, [single]590)
            $g.DrawString(('X {0:G4}' -f $worldX), $small, $muted, ($x + 3), [single]574)
        }
        for ($i = 0; $i -lt 24; $i++) {
            $worldZ = $firstZ + $i * $step; $z = [single](100 + ($worldZ - $topZ) * $scale)
            if ($z -gt 590) { break }
            $g.DrawLine($grid, [single]50, $z, [single]910, $z)
            $g.DrawString(('Z {0:G4}' -f $worldZ), $small, $muted, [single]53, ($z + 2))
        }
        $zeroX = [single](50 - $leftX * $scale); $zeroZ = [single](100 - $topZ * $scale)
        if ($zeroX -ge 50 -and $zeroX -le 910) { $g.DrawLine($axis, $zeroX, [single]100, $zeroX, [single]590) }
        if ($zeroZ -ge 100 -and $zeroZ -le 590) { $g.DrawLine($axis, [single]50, $zeroZ, [single]910, $zeroZ) }
        $labels = 0
        foreach ($box in ($boxes | Sort-Object -Property y)) {
            $hull = Hull $box.corners
            if ($hull.Count -ge 3) {
                $points = New-Object 'System.Drawing.PointF[]' $hull.Count
                for ($i = 0; $i -lt $hull.Count; $i++) {
                    $points[$i] = New-Object System.Drawing.PointF([single](50 + ($hull[$i].x - $leftX) * $scale), [single](100 + ($hull[$i].z - $topZ) * $scale))
                }
                $g.FillPolygon($fill, $points)
                $g.DrawPolygon($outline, $points)
            }
            if ($labels -lt 20 -and -not [string]::IsNullOrWhiteSpace($box.name)) {
                $label = [regex]::Replace($box.name, '[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', ' ')
                if ($label.Length -gt 24) { $label = $label.Substring(0, 23) + '~' }
                $g.DrawString($label, $small, $ink, [single](54 + ($box.x - $leftX) * $scale), [single](104 + ($box.z - $topZ) * $scale))
                $labels++
            }
        }
        if ($null -ne $player) {
            $px = [single](50 + ($player.x - $leftX) * $scale); $pz = [single](100 + ($player.z - $topZ) * $scale)
            $g.FillEllipse($red, ($px - 5), ($pz - 5), [single]10, [single]10)
            $g.DrawString('PLAYER', $small, $red, ($px + 8), ($pz - 15))
        }
        $g.ResetClip()
        $g.DrawRectangle($axis, [single]50, [single]100, [single]860, [single]490)
        $g.DrawLine($axis, [single]60, [single]623, [single]115, [single]623)
        $g.DrawLine($axis, [single]60, [single]623, [single]60, [single]662)
        $g.DrawString('+X >', $small, $ink, [single]119, [single]615)
        $g.DrawString('+Z v', $small, $ink, [single]46, [single]665)
        $scaleLength = $step * $scale
        $g.DrawLine($axis, [single]235, [single]636, [single](235 + $scaleLength), [single]636)
        $g.DrawLine($axis, [single]235, [single]631, [single]235, [single]641)
        $g.DrawLine($axis, [single](235 + $scaleLength), [single]631, [single](235 + $scaleLength), [single]641)
        $g.DrawString(('{0:G4} studs; grid = {0:G4}' -f $step), $small, $ink, [single]235, [single]645)
        $playerText = if ($null -eq $player) { 'Player position unavailable' } else { 'Player X {0:G5}, Y {1:G5}, Z {2:G5}' -f $player.x, $player.y, $player.z }
        $g.DrawString($playerText, $small, $muted, [single]520, [single]617)
        $g.DrawString('Static observation; at most 20 labels', $small, $muted, [single]520, [single]639)
        $g.DrawString('Loaded DTO only; not a full map, terrain, mesh or navigation model.', $small, $muted, [single]30, [single]695)
        return Encode-Jpeg $bitmap $MaxBytes 960 512 384 'client-visible-box-schematic'
    } finally {
        for ($i = $resources.Count - 1; $i -ge 0; $i--) { $resources[$i].Dispose() }
        $bitmap.Dispose()
    }
}

function Overlay-Image($Overlay, [int]$MaxBytes) {
    if ($Overlay.parts -isnot [Array] -or $Overlay.parts.Count -gt 512 -or $Overlay.primitives -isnot [Array] -or $Overlay.primitives.Count -gt 512 -or $Overlay.layer -isnot [string] -or $Overlay.layer.Length -gt 100) { Fail 'invalid-scene' }
    if ($Overlay.linkSummary -isnot [string] -or $Overlay.linkSummary.Length -gt 160 -or $Overlay.linkSummary -match '[\x00-\x1f\x7f-\x9f]') { Fail 'invalid-scene' }
    $items = @($Overlay.parts) + @($Overlay.primitives)
    if ($items.Count -eq 0) { Fail 'map-empty' }
    $minX = [double]::PositiveInfinity; $maxX = [double]::NegativeInfinity
    $minZ = [double]::PositiveInfinity; $maxZ = [double]::NegativeInfinity
    $labels = 0
    foreach ($item in $items) {
        if ($item.kind -notin @('box', 'surface', 'candidate', 'hazard', 'link', 'uncertain-link', 'trail') -or $item.label -isnot [string] -or $item.label.Length -gt 64 -or $item.points -isnot [Array]) { Fail 'invalid-scene' }
        $count = $item.points.Count
        if (($item.kind -in @('box', 'hazard') -and $count -ne 8) -or ($item.kind -in @('surface', 'candidate') -and $count -notin @(3, 4)) -or ($item.kind -in @('link', 'uncertain-link', 'trail') -and $count -ne 2)) { Fail 'invalid-scene' }
        if ($item.label.Length -gt 0) { $labels++ }
        foreach ($p in $item.points) {
            $x = Finite-Number $p.x 3e9; $z = Finite-Number $p.z 3e9
            $minX = [Math]::Min($minX, $x); $maxX = [Math]::Max($maxX, $x)
            $minZ = [Math]::Min($minZ, $z); $maxZ = [Math]::Max($maxZ, $z)
        }
    }
    if ($labels -gt 20) { Fail 'invalid-scene' }
    $scale = [Math]::Min(860 / [Math]::Max(20, $maxX - $minX), 470 / [Math]::Max(20, $maxZ - $minZ))
    $bitmap = New-Object System.Drawing.Bitmap(960, 720, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $resources = New-Object 'System.Collections.Generic.List[System.IDisposable]'
    try {
        $g = [System.Drawing.Graphics]::FromImage($bitmap); $resources.Add($g)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::FromArgb(245, 247, 248))
        $font = New-Object System.Drawing.Font('Segoe UI', 10); $resources.Add($font)
        $title = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold); $resources.Add($title)
        $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(24, 40, 50)); $resources.Add($ink)
        $g.DrawString('RECORDED MAP - PARTIAL / UNCERTAIN', $title, $ink, [single]30, [single]20)
        $g.DrawString(('Oblique X/Z/Y projection | {0} | not live safety' -f $Overlay.layer), $font, $ink, [single]30, [single]57)
        $g.DrawString($Overlay.linkSummary, $font, $ink, [single]30, [single]78)
        $g.SetClip((New-Object System.Drawing.Rectangle(30, 100, 900, 490)))
        foreach ($item in $items) {
            $color = switch ($item.kind) {
                'box' { [System.Drawing.Color]::FromArgb(100, 125, 140) }
                'surface' { [System.Drawing.Color]::FromArgb(35, 116, 147) }
                'candidate' { [System.Drawing.Color]::FromArgb(160, 120, 38) }
                'hazard' { [System.Drawing.Color]::FromArgb(185, 45, 36) }
                'trail' { [System.Drawing.Color]::FromArgb(117, 60, 155) }
                default { [System.Drawing.Color]::FromArgb(32, 105, 95) }
            }
            $pen = New-Object System.Drawing.Pen($color, 1.5)
            $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(45, $color))
            try {
                if ($item.kind -in @('candidate', 'uncertain-link', 'hazard', 'trail')) { $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash }
                if ($item.kind -in @('link', 'uncertain-link')) { $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::ArrowAnchor }
                $points = New-Object 'System.Drawing.PointF[]' $item.points.Count
                for ($i = 0; $i -lt $points.Count; $i++) {
                    $points[$i] = New-Object System.Drawing.PointF([single](50 + ($item.points[$i].x - $minX) * $scale), [single](110 + ($item.points[$i].z - $minZ) * $scale))
                }
                if ($item.kind -in @('box', 'hazard')) {
                    foreach ($edge in @(@(0,1),@(1,2),@(2,3),@(3,0),@(4,5),@(5,6),@(6,7),@(7,4),@(0,4),@(1,5),@(2,6),@(3,7))) { $g.DrawLine($pen, $points[$edge[0]], $points[$edge[1]]) }
                } elseif ($item.kind -in @('surface', 'candidate')) {
                    $g.FillPolygon($brush, $points); $g.DrawPolygon($pen, $points)
                } else {
                    $g.DrawLine($pen, $points[0], $points[1])
                    if ($points[0].Equals($points[1])) { $g.DrawEllipse($pen, ($points[0].X - 4), ($points[0].Y - 4), [single]8, [single]8) }
                }
                if ($item.label.Length -gt 0) { $g.DrawString($item.label, $font, $ink, ($points[0].X + 3), ($points[0].Y + 3)) }
            } finally { $pen.Dispose(); $brush.Dispose() }
        }
        $g.ResetClip()
        $g.DrawString('World Y up; X right; Z diagonally left/down. Exact-equivalent link paths are drawn once.', $font, $ink, [single]30, [single]610)
        $g.DrawString('Blue: modeled support | amber/dashes: candidate | switches: user-report, time unknown', $font, $ink, [single]30, [single]634)
        $g.DrawString('Red: hazard evidence envelope (not proof) | purple: recorded motion trail', $font, $ink, [single]30, [single]658)
        $g.DrawString('Windows remain in JSON, not intervals inferred here. Limits/occlusion may omit data; 20 labels.', $font, $ink, [single]30, [single]687)
        return Encode-Jpeg $bitmap $MaxBytes 960 512 384 'client-visible-box-schematic'
    } finally {
        for ($i = $resources.Count - 1; $i -ge 0; $i--) { $resources[$i].Dispose() }
        $bitmap.Dispose()
    }
}

$result = @{ schema = 1; screenshot = (NotRequested); map = (NotRequested) }
try {
    # Read one bounded payload through EOF. Oversized input is rejected, not silently truncated.
    $buffer = New-Object 'char[]' 4096
    $inputText = New-Object System.Text.StringBuilder
    while (($count = [Console]::In.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($inputText.Length + $count -gt 262144) { Fail 'invalid-scene' }
        $null = $inputText.Append($buffer, 0, $count)
    }
    if ([System.Text.Encoding]::UTF8.GetByteCount($inputText.ToString()) -gt 262144) { Fail 'invalid-scene' }
    $request = ConvertFrom-Json -InputObject $inputText.ToString()
    if ($request.schema -ne 1 -or $request.screenshot -isnot [bool] -or $request.map -isnot [bool] -or $request.maxBytes -isnot [int] -or $request.maxBytes -lt 4096 -or $request.maxBytes -gt 131072) { Fail 'image-budget' }
    if ($request.screenshot) { $result.screenshot = Unavailable 'helper-unavailable' }
    if ($request.map) { $result.map = Unavailable 'helper-unavailable' }
    Add-Type -AssemblyName System.Drawing
    $captureReasons = @('target-not-found', 'target-ambiguous', 'target-not-visible', 'target-changed', 'target-unavailable', 'window-size-limit', 'capture-failed', 'capture-uniform', 'image-budget', 'helper-unavailable')
    if ($request.screenshot) {
        try { $result.screenshot = Capture-Window $request.maxBytes }
        catch {
            $reason = $_.Exception.Message
            if ($reason -notin $captureReasons) { $reason = 'capture-failed' }
            $result.screenshot = Unavailable $reason
        }
    }
    if ($request.map) {
        try {
            if ($null -ne $request.mapOverlay) { $result.map = Overlay-Image $request.mapOverlay $request.maxBytes }
            else { $result.map = Map-Image $request.scene $request.maxBytes }
        }
        catch {
            $reason = $_.Exception.Message
            if ($reason -notin @('invalid-scene', 'map-empty', 'image-budget', 'helper-unavailable')) { $reason = 'map-render-failed' }
            $result.map = Unavailable $reason
        }
    }
} catch {
    # Never serialize exceptions: they may contain paths or local account information.
    if ($result.screenshot.status -ne 'not-requested') { $result.screenshot = Unavailable 'helper-unavailable' }
    if ($result.map.status -ne 'not-requested') { $result.map = Unavailable 'helper-unavailable' }
}
$encoded = ConvertTo-Json -InputObject $result -Depth 8 -Compress
if ([System.Text.Encoding]::UTF8.GetByteCount($encoded) -gt 1048576) {
    if ($result.screenshot.status -ne 'not-requested') { $result.screenshot = Unavailable 'helper-output-limit' }
    if ($result.map.status -ne 'not-requested') { $result.map = Unavailable 'helper-output-limit' }
    $encoded = ConvertTo-Json -InputObject $result -Depth 8 -Compress
}
[Console]::Out.Write($encoded)
