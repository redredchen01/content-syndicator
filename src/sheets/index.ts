import { google } from 'googleapis';
import { logger } from '../utils/logger';

export async function appendToSheet(originalUrl: string, generatedTitle: string, publishResults: any[]) {
  try {
    const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    const sheetId = process.env.GOOGLE_SHEET_ID;

    if (!credsJson || !sheetId) {
      logger.warn('Google Sheets credentials not configured. Skipping append.');
      return;
    }

    const credentials = JSON.parse(credsJson);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Prepare data: Timestamp, Original URL, Generated Title, URLs of published platforms...
    const timestamp = new Date().toISOString();
    
    // We assume columns: Timestamp, Source URL, Generated Title, Telegra.ph, Dev.to, Medium
    const telegraphResult = publishResults.find(r => r.platform === 'Telegra.ph');
    const devtoResult = publishResults.find(r => r.platform === 'Dev.to');
    const mediumResult = publishResults.find(r => r.platform === 'Medium');

    const row = [
      timestamp,
      originalUrl,
      generatedTitle,
      telegraphResult?.success ? telegraphResult.publishedUrl : (telegraphResult?.error || 'N/A'),
      devtoResult?.success ? devtoResult.publishedUrl : (devtoResult?.error || 'N/A'),
      mediumResult?.success ? mediumResult.publishedUrl : (mediumResult?.error || 'N/A')
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:F', // adjust if needed
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row]
      }
    });

    logger.success('Successfully appended record to Google Sheets');
  } catch (error: any) {
    logger.error('Failed to append to Google Sheets', error);
  }
}
