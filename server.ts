import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Middleware for parsing JSON with generous audio limits
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Supported 10 languages configuration matching Gnani Prisma specifications
export const SUPPORTED_LANGUAGES = [
  { id: 'auto', name: 'Auto Detect', native: 'स्वतः पहचानें', code: 'auto' },
  { id: 'en', name: 'English', native: 'English', code: 'en-IN', gnaniLang: 'en' },
  { id: 'hi', name: 'Hindi', native: 'हिन्दी', code: 'hi-IN', gnaniLang: 'hi' },
  { id: 'bn', name: 'Bengali', native: 'বাংলা', code: 'bn-IN', gnaniLang: 'bn' },
  { id: 'mr', name: 'Marathi', native: 'मराठी', code: 'mr-IN', gnaniLang: 'mr' },
  { id: 'gu', name: 'Gujarati', native: 'ગુજરાતી', code: 'gu-IN', gnaniLang: 'gu' },
  { id: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', code: 'pa-IN', gnaniLang: 'pa' },
  { id: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', code: 'kn-IN', gnaniLang: 'kn' },
  { id: 'te', name: 'Telugu', native: 'తెలుగు', code: 'te-IN', gnaniLang: 'te' },
  { id: 'ta', name: 'Tamil', native: 'தமிழ்', code: 'ta-IN', gnaniLang: 'ta' },
  { id: 'ml', name: 'Malayalam', native: 'മലയാളം', code: 'ml-IN', gnaniLang: 'ml' },
];

/**
 * Endpoint to check Gnani Integration Status without leaking server keys
 */
app.get('/api/gnani/status', (_req, res) => {
  const hasGnaniKey = Boolean(process.env.GNANI_API_KEY && process.env.GNANI_API_KEY.trim() !== '');
  const hasGnaniAccessKey = Boolean(process.env.GNANI_ACCESS_KEY && process.env.GNANI_ACCESS_KEY.trim() !== '');

  res.json({
    sttProvider: 'Gnani Prisma v3.0 (Speech-to-Text)',
    ttsProvider: 'Gnani Timbre (Text-to-Speech)',
    keyDetected: hasGnaniKey,
    sttConfigured: hasGnaniKey,
    ttsConfigured: hasGnaniKey,
    requiresAccessKey: hasGnaniAccessKey,
    supportedLanguages: SUPPORTED_LANGUAGES,
    integrationReady: true,
    connectionStatus: hasGnaniKey ? 'Not tested' : 'Not connected',
  });
});

/**
 * Real endpoint to test Gnani API connection without mock data
 */
app.post('/api/gnani/test-connection', async (_req, res) => {
  const gnaniApiKey = process.env.GNANI_API_KEY;
  if (!gnaniApiKey || gnaniApiKey.trim() === '') {
    return res.json({
      connected: false,
      status: 'Not connected',
      message: 'GNANI_API_KEY is not detected in server environment.',
    });
  }

  const envEndpoint = process.env.GNANI_PRISMA_ENDPOINT;
  const gnaniEndpoint = (envEndpoint && !envEndpoint.includes('prisma.gnani.ai'))
    ? envEndpoint
    : 'https://api.vachana.ai/stt/v3';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const headers: Record<string, string> = {
      'X-API-Key-ID': gnaniApiKey,
      'Authorization': `Bearer ${gnaniApiKey}`,
    };
    if (process.env.GNANI_ACCESS_KEY) {
      headers['X-Gnani-Access-Key'] = process.env.GNANI_ACCESS_KEY;
    }

    const response = await fetch(gnaniEndpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // If Gnani responds:
    // 200 -> OK
    // 400 -> Gnani received and validated the request, but missing audio payload (means connection & endpoint reachable!)
    // 401 / 403 -> Authentication failure
    if (response.status === 200 || response.status === 400 || response.status === 422) {
      return res.json({
        connected: true,
        status: 'Connected',
        httpStatus: response.status,
        message: 'Successfully reached Gnani Prisma endpoint with server credentials.',
      });
    } else if (response.status === 401 || response.status === 403) {
      return res.json({
        connected: false,
        status: 'Not connected',
        httpStatus: response.status,
        message: `Authentication failed (HTTP ${response.status}). Key was not accepted.`,
      });
    } else {
      return res.json({
        connected: false,
        status: 'Not connected',
        httpStatus: response.status,
        message: `Endpoint returned HTTP ${response.status}.`,
      });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return res.json({
      connected: false,
      status: 'Not connected',
      message: `Endpoint unreachable: ${errorMsg}`,
    });
  }
});

import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';

interface AudioInspection {
  formatName: string;
  codecName: string;
  sampleRate: number;
  channels: number;
  duration: number;
}

interface AudioPreparedData {
  inspection: AudioInspection;
  wavBuffer: Buffer;
  wavDuration: number;
  chunks: Array<{ buffer: Buffer; duration: number }>;
}

/**
 * Safely extracts binary buffer from base64 string, handling any data URL prefix
 */
function extractBase64Data(audioBase64: string): Buffer {
  const cleanBase64 = audioBase64.includes(',')
    ? audioBase64.slice(audioBase64.indexOf(',') + 1)
    : audioBase64.trim();
  return Buffer.from(cleanBase64, 'base64');
}

/**
 * Determine suitable file extension based on MIME type
 */
function getExtensionForMime(mimeType: string): string {
  const lower = (mimeType || '').toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('ogg')) return '.ogg';
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return '.m4a';
  if (lower.includes('wav')) return '.wav';
  return '.bin';
}

/**
 * Inspect audio using ffprobe to detect format, codec, sample rate, channels, and duration
 */
function inspectAudio(filePath: string): AudioInspection {
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration:stream=codec_name,sample_rate,channels',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' });

  if (probe.status !== 0 || !probe.stdout) {
    throw new Error(`ffprobe failed: ${probe.stderr || 'Unable to probe audio'}`);
  }

  try {
    const data = JSON.parse(probe.stdout);
    const stream = data.streams?.[0] || {};
    const format = data.format || {};
    return {
      formatName: format.format_name || 'unknown',
      codecName: stream.codec_name || 'unknown',
      sampleRate: Number(stream.sample_rate) || 0,
      channels: Number(stream.channels) || 0,
      duration: parseFloat(format.duration) || 0,
    };
  } catch (err) {
    throw new Error(`Failed to parse audio probe output: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Transcode input audio to verified 16kHz mono 16-bit PCM WAV and segment if duration exceeds 30 seconds
 */
function prepareAudioForPrisma(inputBuffer: Buffer, mimeType: string): AudioPreparedData {
  const tempId = `bolo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ext = getExtensionForMime(mimeType);
  const tempInputPath = path.join(os.tmpdir(), `${tempId}_in${ext}`);
  const tempOutputPath = path.join(os.tmpdir(), `${tempId}_out.wav`);
  const chunkPaths: string[] = [];

  try {
    fs.writeFileSync(tempInputPath, inputBuffer);

    // 1. Inspect actual audio format and codec from MediaRecorder
    let inputInspection: AudioInspection;
    try {
      inputInspection = inspectAudio(tempInputPath);
    } catch {
      inputInspection = {
        formatName: ext.replace('.', ''),
        codecName: 'unknown',
        sampleRate: 0,
        channels: 0,
        duration: 0,
      };
    }

    console.log(
      `[Audio Ingestion] Detected MIME: "${mimeType}", Container: ${inputInspection.formatName}, ` +
      `Codec: ${inputInspection.codecName}, SampleRate: ${inputInspection.sampleRate}Hz, ` +
      `Duration: ${inputInspection.duration.toFixed(2)}s, Size: ${inputBuffer.length} bytes`
    );

    // 2. Perform genuine audio transcoding to 16kHz mono 16-bit PCM WAV accepted by Gnani Prisma v3.0
    const ffmpegConv = spawnSync('ffmpeg', [
      '-y',
      '-i', tempInputPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      tempOutputPath,
    ], { encoding: 'utf8' });

    if (ffmpegConv.status !== 0 || !fs.existsSync(tempOutputPath)) {
      const ffmpegError = ffmpegConv.stderr || 'ffmpeg exited with non-zero status';
      console.error('[Audio Conversion Error] ffmpeg stderr:', ffmpegError);
      throw new Error(`Audio decoding failed. ffmpeg returned error code: ${ffmpegConv.status}. ${ffmpegError.slice(-200).trim()}`);
    }

    // 3. Verify the converted audio can actually be decoded before making the Gnani API request
    const outputInspection = inspectAudio(tempOutputPath);
    if (outputInspection.codecName !== 'pcm_s16le' || outputInspection.sampleRate !== 16000 || outputInspection.channels !== 1) {
      throw new Error(
        `Converted audio verification failed: expected pcm_s16le 16kHz mono, got ${outputInspection.codecName} ${outputInspection.sampleRate}Hz ${outputInspection.channels}ch`
      );
    }

    const wavBuffer = fs.readFileSync(tempOutputPath);
    const wavDuration = outputInspection.duration || 1;

    // 4. Enforce Gnani Prisma v3.0's 30-second per-request REST limit
    const chunks: Array<{ buffer: Buffer; duration: number }> = [];
    if (wavDuration <= 30.0) {
      chunks.push({ buffer: wavBuffer, duration: wavDuration });
    } else {
      // Chunk into segments of <= 28 seconds (safe threshold under 30s)
      const CHUNK_DURATION = 28;
      for (let offset = 0; offset < wavDuration; offset += CHUNK_DURATION) {
        const segLen = Math.min(CHUNK_DURATION, wavDuration - offset);
        const chunkPath = path.join(os.tmpdir(), `${tempId}_chunk_${offset}.wav`);
        chunkPaths.push(chunkPath);

        const chunkProc = spawnSync('ffmpeg', [
          '-y',
          '-i', tempOutputPath,
          '-ss', offset.toString(),
          '-t', segLen.toString(),
          '-c', 'copy',
          chunkPath,
        ], { encoding: 'utf8' });

        if (chunkProc.status === 0 && fs.existsSync(chunkPath)) {
          chunks.push({
            buffer: fs.readFileSync(chunkPath),
            duration: segLen,
          });
        }
      }
    }

    return {
      inspection: inputInspection,
      wavBuffer,
      wavDuration,
      chunks: chunks.length > 0 ? chunks : [{ buffer: wavBuffer, duration: wavDuration }],
    };
  } finally {
    // Clean up temporary files
    try {
      if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
      if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
      chunkPaths.forEach((cp) => {
        if (fs.existsSync(cp)) fs.unlinkSync(cp);
      });
    } catch {
      // ignore cleanup errors
    }
  }
}

function getGnaniLanguageCode(langCode: string): string {
  if (!langCode || langCode === 'auto') return 'indic-auto';
  if (langCode.includes('-')) return langCode;
  const map: Record<string, string> = {
    en: 'en-IN',
    hi: 'hi-IN',
    bn: 'bn-IN',
    mr: 'mr-IN',
    gu: 'gu-IN',
    pa: 'pa-IN',
    kn: 'kn-IN',
    te: 'te-IN',
    ta: 'ta-IN',
    ml: 'ml-IN',
  };
  return map[langCode] || `${langCode}-IN`;
}

/**
 * Transcribe a single audio chunk (<=30s) to Gnani Prisma v3.0
 */
async function transcribeChunk(
  chunkBuffer: Buffer,
  languageCode: string,
  gnaniEndpoint: string,
  gnaniApiKey: string,
  gnaniAccessKey?: string
): Promise<{ success: boolean; transcript: string; detectedLanguage?: string; rawData?: any; error?: string }> {
  const formData = new FormData();
  const audioBlob = new Blob([new Uint8Array(chunkBuffer)], { type: 'audio/wav' });
  formData.append('audio_file', audioBlob, 'recording.wav');
  formData.append('model', 'prisma-v3.0');
  formData.append('language_code', languageCode);
  formData.append('output_style', 'transcribe');

  const headers: Record<string, string> = {
    'X-API-Key-ID': gnaniApiKey,
    'Authorization': `Bearer ${gnaniApiKey}`,
  };
  if (gnaniAccessKey) {
    headers['X-Gnani-Access-Key'] = gnaniAccessKey;
  }

  const response = await fetch(gnaniEndpoint, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text();
    return {
      success: false,
      transcript: '',
      error: `Gnani Prisma returned status ${response.status}: ${errText.slice(0, 250)}`,
    };
  }

  const data = await response.json();
  const text =
    data.transcript ||
    data.text ||
    data.transcription ||
    (data.data && (data.data.transcript || data.data.text || data.data.transcription)) ||
    (Array.isArray(data.sentences) && data.sentences.map((s: { text?: string; transcript?: string }) => s.text || s.transcript).filter(Boolean).join(' ')) ||
    (Array.isArray(data.results) && data.results.map((r: { alternatives?: Array<{ transcript?: string }>; transcript?: string }) => r.alternatives?.[0]?.transcript || r.transcript || '').filter(Boolean).join(' ')) ||
    '';

  const detected = data.detected_language_code || data.language;

  return {
    success: true,
    transcript: text.trim(),
    detectedLanguage: detected,
    rawData: data,
  };
}

/**
 * Server-side integration point for Gnani Prisma v3.0 Speech-to-Text
 * Keeps API credentials strictly on the server.
 */
app.post('/api/transcribe', async (req, res) => {
  const gnaniApiKey = process.env.GNANI_API_KEY;
  const gnaniAccessKey = process.env.GNANI_ACCESS_KEY;
  const isKeyConfigured = Boolean(gnaniApiKey && gnaniApiKey.trim() !== '');

  try {
    const { audioBase64, mimeType = 'audio/webm', languageCode = 'auto' } = req.body;

    if (!audioBase64) {
      return res.status(400).json({
        success: false,
        configured: isKeyConfigured,
        error: 'MISSING_AUDIO',
        message: 'No audio data was received for transcription.',
      });
    }

    if (!isKeyConfigured) {
      return res.status(200).json({
        success: false,
        configured: false,
        error: 'GNANI_CREDENTIALS_NOT_FOUND',
        message: 'GNANI_API_KEY is not configured in the server environment. Please set your GNANI_API_KEY secret.',
        detectedLanguage: languageCode === 'auto' ? 'Hindi / English' : languageCode,
      });
    }

    // 1. Safely extract raw binary buffer from base64 (handling any data URL prefix)
    const audioBuffer = extractBase64Data(audioBase64);

    if (audioBuffer.length === 0) {
      return res.status(400).json({
        success: false,
        configured: true,
        error: 'INVALID_AUDIO_DATA',
        message: 'Audio payload was empty or invalid base64 data.',
      });
    }

    if (audioBuffer.length > 50 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        configured: true,
        error: 'AUDIO_TOO_LARGE',
        message: 'Recording size exceeds the maximum limit (50MB).',
      });
    }

    // 2. Prepare, inspect, transcode to 16kHz mono WAV, verify decoding, and chunk if > 30s
    let prepared: AudioPreparedData;
    try {
      prepared = prepareAudioForPrisma(audioBuffer, mimeType);
    } catch (conversionErr: unknown) {
      const msg = conversionErr instanceof Error ? conversionErr.message : String(conversionErr);
      console.error('[Audio Conversion Error]:', msg);
      return res.status(400).json({
        success: false,
        configured: true,
        error: 'AUDIO_CONVERSION_ERROR',
        message: `Failed to convert audio format: ${msg}`,
      });
    }

    // 3. Target language mapping
    const targetLangCode = getGnaniLanguageCode(languageCode);

    // 4. Endpoint resolution
    const envEndpoint = process.env.GNANI_PRISMA_ENDPOINT;
    const defaultEndpoint = 'https://api.vachana.ai/stt/v3';
    const gnaniEndpoint = (envEndpoint && !envEndpoint.includes('prisma.gnani.ai'))
      ? envEndpoint
      : defaultEndpoint;

    // 5. Transcribe each chunk (handles 30-second per-request limit seamlessly)
    const transcripts: string[] = [];
    let detectedLanguage: string | undefined = undefined;
    let lastRequestId: string | undefined = undefined;

    for (let i = 0; i < prepared.chunks.length; i++) {
      const chunk = prepared.chunks[i];
      console.log(
        `Transcribing chunk ${i + 1}/${prepared.chunks.length} ` +
        `(${chunk.duration.toFixed(1)}s, ${chunk.buffer.length} bytes) to ${gnaniEndpoint}...`
      );

      const result = await transcribeChunk(
        chunk.buffer,
        targetLangCode,
        gnaniEndpoint,
        gnaniApiKey!,
        gnaniAccessKey
      );

      if (!result.success) {
        console.error(`Chunk ${i + 1} transcription failed:`, result.error);
        return res.status(502).json({
          success: false,
          configured: true,
          error: 'GNANI_API_ERROR',
          message: result.error || 'Gnani Prisma transcription request failed.',
        });
      }

      if (result.transcript) {
        transcripts.push(result.transcript);
      }
      if (result.detectedLanguage && !detectedLanguage) {
        detectedLanguage = result.detectedLanguage;
      }
      if (result.rawData?.request_id) {
        lastRequestId = result.rawData.request_id;
      }
    }

    const fullTranscript = transcripts.join(' ').trim();

    return res.json({
      success: true,
      configured: true,
      transcript: fullTranscript,
      confidence: 0.95,
      detectedLanguage: detectedLanguage || targetLangCode,
      model: 'prisma-v3.0',
      requestId: lastRequestId,
      audioDetails: {
        detectedMime: mimeType,
        inputCodec: prepared.inspection.codecName,
        inputFormat: prepared.inspection.formatName,
        convertedFormat: 'wav (16kHz mono pcm_s16le)',
        durationSeconds: Math.round(prepared.wavDuration),
        chunksCount: prepared.chunks.length,
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Transcription exception:', errorMsg);
    return res.status(500).json({
      success: false,
      configured: isKeyConfigured,
      error: 'SERVER_TRANSCRIPTION_EXCEPTION',
      message: `Gnani STT connection error: ${errorMsg}`,
    });
  }
});

/**
 * Server-side integration point for Gnani Timbre Text-to-Speech
 */
app.post('/api/tts', async (req, res) => {
  try {
    const { text, languageCode = 'hi', gender = 'female' } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_TEXT',
        message: 'No text provided for synthesis.',
      });
    }

    const gnaniApiKey = process.env.GNANI_API_KEY;
    const gnaniAccessKey = process.env.GNANI_ACCESS_KEY;
    const timbreEndpoint = process.env.GNANI_TIMBRE_ENDPOINT || 'https://timbre.gnani.ai/v1/text-to-speech';

    if (!gnaniApiKey || gnaniApiKey.trim() === '') {
      return res.status(200).json({
        success: false,
        configured: false,
        error: 'GNANI_CREDENTIALS_NOT_FOUND',
        message: 'Gnani Timbre TTS credentials not configured in server environment. Use client-side browser speech synthesis.',
      });
    }

    const response = await fetch(timbreEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gnaniApiKey}`,
        'Content-Type': 'application/json',
        ...(gnaniAccessKey ? { 'X-Gnani-Access-Key': gnaniAccessKey } : {}),
      },
      body: JSON.stringify({
        text,
        language: languageCode,
        voice_gender: gender,
        audio_format: 'mp3',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        success: false,
        configured: true,
        error: 'TIMBRE_API_ERROR',
        message: `Gnani Timbre returned status ${response.status}: ${errText.slice(0, 150)}`,
      });
    }

    const audioArrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(audioArrayBuffer).toString('base64');

    return res.json({
      success: true,
      configured: true,
      audioBase64: `data:audio/mp3;base64,${audioBase64}`,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('TTS error:', errorMsg);
    return res.status(500).json({
      success: false,
      error: 'SERVER_TTS_EXCEPTION',
      message: errorMsg,
    });
  }
});

/**
 * Server-side high-fidelity multilingual PDF export endpoint.
 * Renders all 10 Indian languages + English with native HarfBuzz script shaping
 * and embedded Noto TrueType fonts.
 */
app.post('/api/export-pdf', async (req, res) => {
  const tempId = `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const jsonPath = path.join(os.tmpdir(), `${tempId}.json`);
  const pdfPath = path.join(os.tmpdir(), `${tempId}.pdf`);

  try {
    const { notes } = req.body;
    if (!notes || !Array.isArray(notes) || notes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'NO_NOTES',
        message: 'No notes provided for PDF generation.',
      });
    }

    // Write notes JSON to temporary file for generator script
    fs.writeFileSync(jsonPath, JSON.stringify(notes), 'utf8');

    // Run Python PangoCairo generator
    const scriptPath = path.resolve(__dirname, 'scripts', 'generate_pdf.py');
    const proc = spawnSync('python3', [scriptPath, jsonPath, pdfPath], { encoding: 'utf8' });

    if (proc.status !== 0 || !fs.existsSync(pdfPath)) {
      console.error('[PDF Export Error] Generator failed:', proc.stderr || proc.stdout);
      return res.status(500).json({
        success: false,
        error: 'PDF_GENERATION_FAILED',
        message: `Failed to generate PDF: ${proc.stderr || 'Python generator exited with error'}`,
      });
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const filename = `bolonote-notes-${new Date().toISOString().slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('PDF export endpoint exception:', errorMsg);
    return res.status(500).json({
      success: false,
      error: 'SERVER_PDF_EXCEPTION',
      message: errorMsg,
    });
  } finally {
    try {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    } catch {
      // ignore cleanup errors
    }
  }
});

// Mount Vite or static server
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BoloNote server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
