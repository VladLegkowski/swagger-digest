import type { JsonObject } from '../types.js';
import { cleanText, entries, isObject } from './utils.js';

function describeSecurityScheme(name: string, scheme: JsonObject): string {
  const type = cleanText(scheme.type).toLowerCase();
  const label = cleanText(scheme.description);
  let details = name;
  if (type === 'http' && cleanText(scheme.scheme).toLowerCase() === 'bearer')
    details += ' (Bearer token via Authorization header)';
  else if (type === 'http' && cleanText(scheme.scheme).toLowerCase() === 'basic')
    details += ' (HTTP Basic via Authorization header)';
  else if (type === 'apikey' || type === 'apiKey')
    details += ` (API key in ${cleanText(scheme.in) || 'header'}: ${cleanText(scheme.name) || 'key'})`;
  else if (type === 'oauth2') {
    const flows =
      entries(scheme.flows)
        .map(([flowName]) => flowName)
        .join(', ') || cleanText(scheme.flow);
    details += ` (OAuth2${flows ? `; ${flows}` : ''})`;
  } else if (type === 'openidconnect' || type === 'openIdConnect') details += ' (OpenID Connect)';
  else if (type === 'basic') details += ' (HTTP Basic)';
  else if (type) details += ` (${type})`;
  if (label) details += ` — ${label}`;
  return details;
}

export function getSecuritySchemes(spec: JsonObject): Array<[string, JsonObject]> {
  const dictionary = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  return entries(dictionary).filter((entry): entry is [string, JsonObject] => isObject(entry[1]));
}

export function securityRequirement(spec: JsonObject, operation: JsonObject): string {
  const security = operation.security !== undefined ? operation.security : spec.security;
  if (!Array.isArray(security) || security.length === 0) return 'None explicitly required';
  const allSchemes = new Map(getSecuritySchemes(spec));
  return security
    .map((requirement: unknown) => {
      if (!isObject(requirement)) return '';
      const names = Object.entries(requirement).map(([name, scopes]) => {
        const label = allSchemes.has(name) ? name : `${name} (scheme not defined)`;
        return Array.isArray(scopes) && scopes.length ? `${label} [scopes: ${scopes.join(', ')}]` : label;
      });
      return names.length ? names.join(' + ') : 'No auth';
    })
    .filter(Boolean)
    .join(' OR ');
}

export function authOverview(spec: JsonObject): string[] {
  const schemes = getSecuritySchemes(spec);
  if (!schemes.length) return ['- **Authentication:** No security schemes declared.'];
  const globalSecurity = securityRequirement(spec, {});
  return [
    `- **Authentication required globally:** ${globalSecurity}`,
    '- **Available schemes:**',
    ...schemes.map(([name, scheme]) => `  - ${describeSecurityScheme(name, scheme)}`),
  ];
}
