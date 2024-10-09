import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, Edit, Zap, ArrowUp, ArrowDown } from 'react-feather';
import { Button } from '../components/button/Button';
import { SimliClient } from 'simli-client';
import './ConsolePage.scss';


const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';


interface Coordinates {
  lat: number;
  lng: number;
  location?: string;
  temperature?: {
    value: number;
    units: string;
  };
  wind_speed?: {
    value: number;
    units: string;
  };
}


interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

function resampleAudioData(
  inputData: Int16Array,
  inputSampleRate: number,
  outputSampleRate: number
): Int16Array {
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(inputData.length / sampleRateRatio);
  const outputData = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * sampleRateRatio;
    const lowerIndex = Math.floor(sourceIndex);
    const upperIndex = Math.min(lowerIndex + 1, inputData.length - 1);
    const interpolation = sourceIndex - lowerIndex;
    outputData[i] =
      (1 - interpolation) * inputData[lowerIndex] +
      interpolation * inputData[upperIndex];
  }

  return outputData;
}



export function ConsolePage() {
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
    prompt('OpenAI API Key') ||
    '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }


  const [showEvents, setShowEvents] = useState(false);
  const [showConversations, setShowConversations] = useState(false);

  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
          apiKey: apiKey,
          dangerouslyAllowAPIKeyInBrowser: true,
        }
    )
  );

  // Simli refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClientRef = useRef<SimliClient | null>(null);
  const simliAudioBufferRef = useRef<Uint8Array[]>([]);



  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());


  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});
  const [coords, setCoords] = useState<Coordinates | null>({
    lat: 37.775593,
    lng: -122.418137,
  });
  const [marker, setMarker] = useState<Coordinates | null>(null);


  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);


  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);


  const isSimliDataChannelOpen = () => {
    if (!simliClientRef.current) return false;

    // Access internal properties (may vary depending on SimliClient implementation)
    const pc = (simliClientRef.current as any).pc as RTCPeerConnection | null;
    const dc = (simliClientRef.current as any).dc as RTCDataChannel | null;

    return (
      pc !== null &&
      pc.iceConnectionState === 'connected' &&
      dc !== null &&
      dc.readyState === 'open'
    );
  };


  /**
   * Connect to conversation:
   * WavRecorder taks speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Define audio constraints for noise suppression, echo cancellation, and auto gain control
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };

    // Set state variables
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    // Start Simli WebRTC connection
    if (simliClientRef.current) {
      simliClientRef.current.start();

      // Send empty audio data to Simli
      const audioData = new Uint8Array(6000).fill(0);
      simliClientRef.current.sendAudioData(audioData);
      console.log('Sent initial empty audio data to Simli');
    }

    // Now connect to OpenAI's realtime API
    await client.connect();

    // Connect to microphone
    await wavRecorder.begin();

    // Connect to audio output
    await wavStreamPlayer.connect();

    if (client.getTurnDetectionType() === 'server_vad') {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, []);

  const changeVoiceType = async () => {
    const client = clientRef.current;

    /**
    // Access the voice setting from the environment variable
    */
    // Define allowed voices
    const allowedVoices: Array<'shimmer' | 'alloy' | 'echo'> = ['shimmer', 'alloy', 'echo'];

    // Get voice from environment variable (defaults to 'shimmer' if not set)
    const voice = process.env.REACT_APP_VOICE || 'echo';

    // Validate that the voice is one of the allowed options
    const validVoice = allowedVoices.includes(voice as 'shimmer' | 'alloy' | 'echo')
      ? (voice as 'shimmer' | 'alloy' | 'echo')
      : 'shimmer';  // Default to 'shimmer' if invalid

    client.updateSession({
      voice: validVoice,
    });
  };

  // Use useEffect to call the function on component mount
  useEffect(() => {
    changeVoiceType();
  }, []);


  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();

    // Close Simli connection
    if (simliClientRef.current) {
      simliClientRef.current.close();
    }
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * In push-to-talk mode, start recording
   * .appendInputAudio() for each sample
   */
  const startRecording = async () => {
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }
    await wavRecorder.record((data) => client.appendInputAudio(data.mono));
  };

  /**
   * In push-to-talk mode, stop recording
   */
  const stopRecording = async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
  };

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
    }
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    if (value === 'server_vad' && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
    setCanPushToTalk(value === 'none');
  };

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    changeTurnEndType('server_vad');
  }, []);

  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#fcc909',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#8d8d8d',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  const [isSimliReady, setIsSimliReady] = useState(false);



  useEffect(() => {
    // Get refs
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // Initialize SimliClient
    if (videoRef.current && audioRef.current) {
      const simliApiKey = '7u9k31cjc3350xyfo8tvfq'
      const simliFaceID = "832c75a8-001f-4a2a-805b-516d4b8ea047";

      if (!simliApiKey || !simliFaceID) {
        console.error('Simli API key or Face ID is not defined');
      } else {
        const SimliConfig = {
          apiKey: simliApiKey,
          faceID: simliFaceID,
          handleSilence: true,
          videoRef: videoRef,
          audioRef: audioRef,
        };

        simliClientRef.current = new SimliClient();
        simliClientRef.current.Initialize(SimliConfig);

        simliClientRef.current.on('connected', () => {
          setIsSimliReady(true);
          console.log('SimliClient connected');
          // Optionally send an initial command to start the avatar's animation
          // simliClientRef.current.sendText('Hello');
        });

        simliClientRef.current.on('error', (error) => {
          console.error('SimliClient error:', error);
        });


        console.log('Simli Client initialized');
      }
    }

    // Set instructions
    client.updateSession({ instructions: instructions });
    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      // Stop sending further audio data to Simli
      simliAudioBufferRef.current = [];

    });

    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();

      if (delta?.audio) {
        if (simliClientRef.current) {
          const audioData = new Int16Array(delta.audio);
          const resampledAudioData = resampleAudioData(audioData, 24000, 16000);

          if (isSimliDataChannelOpen()) {
            // Send buffered audio first
            if (simliAudioBufferRef.current.length > 0) {
              simliAudioBufferRef.current.forEach((bufferedData) => {
                simliClientRef.current!.sendAudioData(bufferedData);
              });
              simliAudioBufferRef.current = [];
            }
            // Send current resampled audio data
            const resampledAudioDataUint8 = new Uint8Array(resampledAudioData.buffer);
            simliClientRef.current.sendAudioData(resampledAudioDataUint8);
          } else {
            // Buffer the resampled audio data
            const resampledAudioDataUint8 = new Uint8Array(resampledAudioData.buffer);
            simliAudioBufferRef.current.push(resampledAudioDataUint8);
            console.warn('Data channel is not open yet, buffering audio data');
          }
        }
      }

      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });



    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();

      // Close SimliClient on unmount
      if (simliClientRef.current) {
        simliClientRef.current.close();
      }
    };
  }, []);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="https://www.enabel.be/app/uploads/2022/06/enabel-logo-color.svg" alt="Enabel Logo" style={{ width: '130px', height: '30px' }} />
          {/* <span>realtime console</span> */}
        </div>
        <div className="content-api-key">
          {!LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={() => resetAPIKey()}
            />
          )}
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="content-block events">
            {/* <div className="visualization">
              <div className="visualization-entry client">
                <canvas ref={clientCanvasRef} />
              </div>
              <div className="visualization-entry server">
                <canvas ref={serverCanvasRef} />
              </div>
            </div> */}

            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="video-background"
            />
            <audio ref={audioRef} autoPlay />

            {/* <div className="content-block-title">events</div> */}
            {/* <div className="content-block-body" ref={eventsScrollRef}>
              {showEvents && (
                <>
                  {!realtimeEvents.length && `awaiting connection...`}
                  {realtimeEvents.map((realtimeEvent, i) => {
                    const count = realtimeEvent.count;
                    const event = { ...realtimeEvent.event };
                    if (event.type === 'input_audio_buffer.append') {
                      event.audio = `[trimmed: ${event.audio.length} bytes]`;
                    } else if (event.type === 'response.audio.delta') {
                      event.delta = `[trimmed: ${event.delta.length} bytes]`;
                    }
                    return (
                      <div className="event" key={event.event_id}>
                        <div className="event-timestamp">
                          {formatTime(realtimeEvent.time)}
                        </div>
                        <div className="event-details">
                          <div
                            className="event-summary"
                            onClick={() => {
                              // toggle event details
                              const id = event.event_id;
                              const expanded = { ...expandedEvents };
                              if (expanded[id]) {
                                delete expanded[id];
                              } else {
                                expanded[id] = true;
                              }
                              setExpandedEvents(expanded);
                            }}
                          >
                            <div
                              className={`event-source ${event.type === 'error'
                                ? 'error'
                                : realtimeEvent.source
                                }`}
                            >
                              {realtimeEvent.source === 'client' ? (
                                <ArrowUp />
                              ) : (
                                <ArrowDown />
                              )}
                              <span>
                                {event.type === 'error'
                                  ? 'error!'
                                  : realtimeEvent.source}
                              </span>
                            </div>
                            <div className="event-type">
                              {event.type}
                              {count && ` (${count})`}
                            </div>
                          </div>
                          {!!expandedEvents[event.event_id] && (
                            <div className="event-payload">
                              {JSON.stringify(event, null, 2)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div> */}
          </div>
          <div className="content-actions">
            {/* <Toggle
              defaultValue={false}
              labels={['manual', 'vad']}
              values={['none', 'server_vad']}
              onChange={(_, value) => changeTurnEndType(value)}
            /> */}
            {/* <div className="spacer" /> */}
            {/* {isConnected && canPushToTalk && (
              <Button
                label={isRecording ? 'release to send' : 'push to talk'}
                buttonStyle={isRecording ? 'alert' : 'regular'}
                disabled={!isConnected || !canPushToTalk}
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
              />
            )} */}
            {/* <div className="spacer" /> */}
            <Button
              label={isConnected ? 'Disconnect' : 'Connect'}
              iconPosition={isConnected ? 'end' : 'start'}
              icon={isConnected ? X : Zap}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={
                isConnected ? disconnectConversation : connectConversation
              }
            />
          </div>
        </div>
        {/* <div className="content-right">
          <div className="content-block map">
            <div className="content-block-title">get_weather()</div>
            <div className="content-block-title bottom">
              {marker?.location || 'not yet retrieved'}
              {!!marker?.temperature && (
                <>
                  <br />
                  🌡️ {marker.temperature.value} {marker.temperature.units}
                </>
              )}
              {!!marker?.wind_speed && (
                <>
                  {' '}
                  🍃 {marker.wind_speed.value} {marker.wind_speed.units}
                </>
              )}
            </div>
            <div className="content-block-body full">
              {coords && (
                <Map
                  center={[coords.lat, coords.lng]}
                  location={coords.location}
                />
              )}
            </div>
          </div>
          <div className="content-block kv">
            <div className="content-block-title">set_memory()</div>
            <div className="content-block-body content-kv">
              {JSON.stringify(memoryKv, null, 2)}
            </div>
          </div>
        </div> */}
      </div>
    </div>
  );
}
