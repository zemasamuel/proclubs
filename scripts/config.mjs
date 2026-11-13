// Club settings. clubId comes from the URL of your club page on ea.com.
export const CLUB_ID = process.env.EA_CLUB_ID || '56770';
export const PLATFORM = process.env.EA_PLATFORM || 'common-gen5'; // PS5, Xbox Series and PC share this
export const API_BASE = process.env.EA_API_BASE || 'https://proclubs.ea.com/api/fc';
export const MATCH_TYPES = ['leagueMatch', 'playoffMatch', 'friendlyMatch'];
