// Resolve security cmdlets from the OS module without add-on module discovery.
export const WINDOWS_POWERSHELL_SECURITY_PRELUDE = "Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop; ";

export function windowsPowerShellEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  // Windows PowerShell must rebuild its module path instead of inheriting pwsh modules.
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  return environment;
}
