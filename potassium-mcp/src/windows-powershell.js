export function windowsPowerShellEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  // Windows PowerShell must rebuild its module path instead of inheriting pwsh modules.
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  }
  return environment;
}
