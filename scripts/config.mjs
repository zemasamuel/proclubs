// Club settings. The club ID comes from the URL of your club page on ea.com.
// Both can be overridden with the EA_CLUB_ID and EA_PLATFORM environment variables.
export const CLUB_ID = process.env.EA_CLUB_ID || '56770';
export const PLATFORM = process.env.EA_PLATFORM || 'common-gen5'; // PS5, Xbox Series and PC share this
export const API_BASE = 'https://proclubs.ea.com/api/fc';
export const MATCH_TYPES = ['leagueMatch', 'playoffMatch', 'friendlyMatch'];

if (!/^\d{1,12}$/.test(CLUB_ID)) throw new Error('EA_CLUB_ID must be a number');
if (!/^[a-z0-9-]{1,32}$/.test(PLATFORM)) throw new Error('EA_PLATFORM has an unexpected format');
