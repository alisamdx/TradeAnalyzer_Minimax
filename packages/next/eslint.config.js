import root from '../../eslint.config.js';

/**
 * Extends the root config (06 §4) rather than restating it, so a rule change
 * lands in one place. Only two local additions: this package's own build output,
 * and `no-undef` off for TypeScript.
 */
export default [
  ...root,
  { ignores: ['out/**', 'release/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // TypeScript resolves identifiers itself; leaving `no-undef` on makes
      // eslint report every ambient type (`NodeJS`, `JSX`) as undefined.
      // typescript-eslint recommends disabling it on TS sources for this reason.
      'no-undef': 'off'
    }
  }
];
