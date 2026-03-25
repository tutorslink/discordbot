/**
 * appwrite/collection-ids.js
 *
 * Constants for all Appwrite collection IDs used by the Discord bot.
 *
 * Synced with Website:
 *   discordSubjects, discordSubjectLevels, discordSubjectTutors,
 *   discordTutorProfiles, discordStudentAssignments, discordPendingReviews,
 *   discordReviewConfig, discordModmail, discordInitMessage, discordAdCodes
 *
 * Discord-Only (not synced):
 *   discordCooldowns, discordBumpLeaderboard, discordSticky, discordTickets,
 *   discordTempCreateAd, discordTempTutorAdd, discordTempTutorRemove
 */

export const DB_ID = process.env.APPWRITE_DB_ID || 'tutorslink';

export const COLLECTION_IDS = {
  // Ads (shared with website)
  // NOTE: User requested collection id "ads"
  ads:                 'ads',

  // Synced with Website
  subjects:            'discordSubjects',
  subjectLevels:       'discordSubjectLevels',
  subjectTutors:       'discordSubjectTutors',
  tutorProfiles:       'discordTutorProfiles',
  studentAssignments:  'discordStudentAssignments',
  pendingReviews:      'discordPendingReviews',
  reviewConfig:        'discordReviewConfig',
  modmail:             'discordModmail',
  initMessage:         'discordInitMessage',
  nextAdCodes:         'discordAdCodes',

  // Discord-Only (not synced with website)
  cooldowns:           'discordCooldowns',
  bumpLeaderboard:     'discordBumpLeaderboard',
  sticky:              'discordSticky',
  tickets:             'discordTickets',
  tempCreateAd:        'discordTempCreateAd',
  tempTutorAdd:        'discordTempTutorAdd',
  tempTutorRemove:     'discordTempTutorRemove',
};
