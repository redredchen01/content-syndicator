// src/utils/authManager.ts
import fs from 'fs';
import path from 'path';

// Directory where authentication JSON files are stored
const AUTH_DIR = path.join(process.cwd(), '.auth');

// Base template that contains shared cookie definitions
const BASE_TEMPLATE_PATH = path.join(AUTH_DIR, 'baseAuthTemplate.json');

/**
 * The base template that defines shared cookies and origin structure.
 * Platform‑specific JSON files only add (or overwrite) the fields that differ.
 */
const BASE_TEMPLATE: Record<string, any> = {
  cookies: [
    {
      name: '_ga',
      value: '',
      domain: '.{{DOMAIN}}',
      path: '/',
      expires: 1811990209.524133,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: '_gcl_au',
      value: '',
      domain: '.{{DOMAIN}}',
      path: '/',
      expires: 1785139982,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'NID',
      value: '',
      domain: '.{{DOMAIN}}',
      path: '/',
      expires: 1793175196.958138,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
    // Add more standard cookies here as needed
  ],
  origins: [
    {
      origin: '{{ORIGIN}}',
      localStorage: [],
    },
  ],
};

/**
 * Load a platform‑specific JSON file if it exists.
 * Returns an object with `cookies` and `origins` arrays, or an empty object.
 */
function loadPlatformSpec(): Record<string, any> {
  const platformSpecPath = path.join(AUTH_DIR, 'platformSpec.json'); // generic placeholder
  // In current project each platform has its own file e.g., .auth/instapaper.json
  // For simplicity we merge all *.json files under .auth except the base template
  const files = fs.readdirSync(AUTH_DIR);
  const platformJsonFiles = files.filter(f => f.endsWith('.json') && f !== 'baseAuthTemplate.json' && f !== 'platformSpec.json');
  
  // Merge all platform files into a single spec object
  const mergedSpec: Record<string, any> = {};
  for (const file of platformJsonFiles) {
    const filePath = path.join(AUTH_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    // Deep merge only cookies and origins
    if (json.cookies) mergedSpec.cookies = [...(mergedSpec.cookies || []), ...json.cookies];
    if (json.origins) mergedSpec.origins = [...(mergedSpec.origins || []), ...json.origins];
  }
  return mergedSpec;
}

/**
 * Build a complete auth configuration for the current platform.
 * This merges the base template with any platform‑specific overrides.
 */
export function buildAuthConfig(): Record<string, any> {
  // 1️⃣ Start with a copy of the base template
  const merged = JSON.parse(JSON.stringify(BASE_TEMPLATE));

  // 2️⃣ Merge platform‑specific cookies (simple overwrite)
  const platformCookies = loadPlatformSpec().cookies ?? [];
  if (Array.isArray(platformCookies)) {
    merged.cookies = merged.cookies.map(c => {
      const override = platformCookies.find(p => p.name === c.name);
      return override ? { ...c, ...override } : c;
    });
  }

  // 3️⃣ Merge platform‑specific origins
  const platformOrigins = loadPlatformSpec().origins ?? [];
  if (Array.isArray(platformOrigins)) {
    merged.origins = merged.origins.map(o => {
      const found = platformOrigins.find(p => p.origin === o.origin);
      return found ? { ...o, ...found } : o;
    });
  }

  // 4️⃣ Resolve placeholder tokens
  const domainPlaceholder = (loadPlatformSpec().domainPlaceholder as string) || 'example.com';
  merged.cookies.forEach(c => {
    if (c.domain === '.{{DOMAIN}}') c.domain = `.${domainPlaceholder}`;
  });
  merged.origins.forEach(o => {
    if (o.origin === '{{ORIGIN}}') o.origin = `https://${domainPlaceholder}`;
  });

  // 5️⃣ Write the merged config back to `.auth/merged.json` for browser storage
  const outPath = path.join(AUTH_DIR, 'merged.json');
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Helper to read the merged configuration file.
 */
export function getMergedAuthPath(): string {
  return path.join(AUTH_DIR, 'merged.json');
}