const { syncGoogleReviews } = require('./_google_reviews');

// Runs daily at 7am Mexico City time (13:00 UTC)
exports.handler = async () => {
  try {
    const result = await syncGoogleReviews();
    console.log('[google-reviews-cron] OK', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (error) {
    console.error('[google-reviews-cron] ERROR', error.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
