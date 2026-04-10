const { syncCloudbedsReservations } = require('./_cloudbeds');

// Scheduled function — runs automatically via cron, no auth required.
exports.handler = async () => {
  try {
    const result = await syncCloudbedsReservations({});
    console.log('[cloudbeds-sync-cron] OK', JSON.stringify({
      propertiesScanned: result.propertiesScanned,
      reservationsFetched: result.reservationsFetched,
      reservationsUpserted: result.reservationsUpserted,
      skippedCount: result.skippedCount,
    }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (error) {
    console.error('[cloudbeds-sync-cron] ERROR', error.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
