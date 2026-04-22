// ============================================================
// Homirent — Gmail Review Forwarder
// Captura emails de review de Expedia y Airbnb y los reenvía
// al webhook de inbound email.
//
// Instalar en: administracion@homirent.com (Google Apps Script)
// Trigger: processReviewEmails — cada 4 horas (time-driven)
// ============================================================

var WEBHOOK_URL = 'https://homirent-reviews.netlify.app/api/inbound/email';
var WEBHOOK_SECRET = ''; // Pegar aquí el valor de INBOUND_EMAIL_SECRET en Netlify

// Remitentes y palabras clave por plataforma
var PLATFORMS = [
  {
    name: 'expedia',
    senderPattern: /expedia/i,
    subjectPattern: /new review|nueva rese|comentario|left a review|review from/i,
    labelName: 'forwarded-expedia',
  },
  {
    name: 'airbnb',
    senderPattern: /airbnb/i,
    subjectPattern: /rated their stay|left you a review|review from|new review/i,
    labelName: 'forwarded-airbnb',
  },
];

function getOrCreateLabel(name) {
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === name) return labels[i];
  }
  return GmailApp.createLabel(name);
}

function sendToWebhook(message, platform) {
  var rawBody = '';
  try { rawBody = message.getRawContent(); } catch (e) { rawBody = ''; }

  var payload = {
    connector: 'email',
    sourceAccount: { label: platform.name, connector: platform.name },
    fromEmail: message.getFrom(),
    subject: message.getSubject(),
    rawText: message.getPlainBody(),
    rawHtml: message.getBody(),
    receivedAt: message.getDate().toISOString(),
    messageId: message.getId(),
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    headers: {},
  };

  if (WEBHOOK_SECRET) {
    options.headers['x-inbound-secret'] = WEBHOOK_SECRET;
  }

  var response = UrlFetchApp.fetch(WEBHOOK_URL, options);
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('[' + platform.name + '] Webhook error ' + code + ': ' + response.getContentText());
    return false;
  }
  return true;
}

function processReviewEmails() {
  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  var afterDate = Utilities.formatDate(sevenDaysAgo, 'GMT', 'yyyy/MM/dd');

  PLATFORMS.forEach(function(platform) {
    var label = getOrCreateLabel(platform.labelName);

    // Buscar emails recientes del remitente de la plataforma sin el label de procesado
    var query = 'from:' + platform.name + '.com after:' + afterDate + ' -label:' + platform.labelName;
    var threads = GmailApp.search(query, 0, 50);

    threads.forEach(function(thread) {
      var messages = thread.getMessages();
      messages.forEach(function(message) {
        var subject = message.getSubject() || '';
        var from = message.getFrom() || '';

        // Verificar que el subject corresponde a una review
        if (!platform.subjectPattern.test(subject)) return;

        var ok = sendToWebhook(message, platform);
        if (ok) {
          Logger.log('[' + platform.name + '] Enviado: ' + subject);
        }
      });
      // Marcar hilo como procesado para no reenviarlo en la próxima ejecución
      thread.addLabel(label);
    });
  });
}
