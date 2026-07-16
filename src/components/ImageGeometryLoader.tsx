import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { parseGeometryJson } from '../core/geometry';
import type { PlateGeometry } from '../types/geometry';

interface ImageGeometryLoaderProps {
  imageName: string | null;
  geometryName: string | null;
  showGeometryUpload?: boolean;
  showCameraCapture?: boolean;
  compactConfiguratorMode?: boolean;
  onImageLoaded: (image: HTMLImageElement, fileName: string) => void;
  onGeometryLoaded: (geometry: PlateGeometry, fileName: string) => void;
  onError: (message: string) => void;
}

export function ImageGeometryLoader({
  imageName,
  geometryName,
  showGeometryUpload = false,
  showCameraCapture = false,
  compactConfiguratorMode = false,
  onImageLoaded,
  onGeometryLoaded,
  onError,
}: ImageGeometryLoaderProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('');

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => () => {
    stopCamera();
  }, []);

  const loadCameraDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraStatus('Camera API not available in this browser.');
      return [];
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((device) => device.kind === 'videoinput');
      setCameraDevices(videoDevices);

      if (!selectedCameraId && videoDevices[0]?.deviceId) {
        setSelectedCameraId(videoDevices[0].deviceId);
      }

      return videoDevices;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown camera error.';
      setCameraStatus(`Could not list cameras. ${detail}`);
      return [];
    }
  };

  const startCamera = async (deviceIdOverride?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('Camera API not available in this browser.');
      return;
    }

    try {
      stopCamera();
      setCameraStatus('Starting camera...');

      const devices = await loadCameraDevices();
      const requestedDeviceId = deviceIdOverride || selectedCameraId || devices[0]?.deviceId;

      const constraints: MediaStreamConstraints = {
        video: requestedDeviceId
          ? { deviceId: { exact: requestedDeviceId } }
          : { facingMode: { ideal: 'environment' } },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setCameraActive(true);
      setCameraStatus('Camera active.');
      await loadCameraDevices();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown camera error.';
      setCameraStatus(`Could not start camera. ${detail}`);
      onError(`Could not start camera. ${detail}`);
      stopCamera();
    }
  };

  const handleCameraSelectionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextCameraId = event.currentTarget.value;
    setSelectedCameraId(nextCameraId);

    if (cameraActive) {
      void startCamera(nextCameraId);
    }
  };

  const handleCaptureImage = () => {
    const video = videoRef.current;

    if (!video || !cameraActive || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setCameraStatus('Camera frame is not ready yet.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext('2d');

    if (!context) {
      setCameraStatus('Could not capture camera frame.');
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    const image = new Image();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `camera-acquisition-${timestamp}.png`;

    image.onload = () => {
      onImageLoaded(image, fileName);
      setCameraStatus(`Captured ${fileName}`);
      stopCamera();
    };

    image.onerror = () => {
      setCameraStatus('Could not convert captured camera frame to an image.');
      onError('Could not convert captured camera frame to an image.');
    };

    image.src = dataUrl;
  };

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      onImageLoaded(image, file.name);
      stopCamera();
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      onError(`Could not load image file: ${file.name}`);
    };

    image.src = objectUrl;
  };

  const handleGeometryChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];

    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const geometry = parseGeometryJson(raw);
      onGeometryLoaded(geometry, file.name);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown parsing error.';
      onError(`Could not load geometry file: ${file.name}. ${detail}`);
    }
  };

  if (compactConfiguratorMode) {
    return (
      <section className="control-section compact-configurator-image-loader" aria-labelledby="loader-heading">
        <h2 id="loader-heading">Image</h2>

        <div className="compact-configurator-image-row">
          <span className="compact-configurator-image-prompt">After completing the plate map:</span>
          {showCameraCapture ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void startCamera();
              }}
            >
              ACQUIRE FROM CAMERA
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={() => imageInputRef.current?.click()}
          >
            LOAD IMAGE
          </button>
          <input
            ref={imageInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleImageChange}
          />
        </div>

        {cameraActive || cameraStatus ? (
          <div className="camera-capture-control compact-configurator-camera-control">
            <div className="camera-capture-row">
              <button
                type="button"
                className="primary-button"
                disabled={!cameraActive}
                onClick={handleCaptureImage}
              >
                Capture
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!cameraActive}
                onClick={stopCamera}
              >
                Stop
              </button>
            </div>

            {cameraDevices.length > 1 ? (
              <label className="camera-device-control">
                <span>Camera</span>
                <select value={selectedCameraId} onChange={handleCameraSelectionChange}>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {cameraActive ? (
              <video
                ref={videoRef}
                className="camera-preview"
                playsInline
                muted
              />
            ) : (
              <video
                ref={videoRef}
                className="camera-preview camera-preview-hidden"
                playsInline
                muted
              />
            )}

            {cameraStatus ? <p className="file-name">{cameraStatus}</p> : null}
          </div>
        ) : null}

        {imageName ? <p className="file-name compact-configurator-image-name">{imageName}</p> : null}
      </section>
    );
  }

  return (
    <section className="control-section" aria-labelledby="loader-heading">
      <h2 id="loader-heading">Files</h2>

      <label className="file-control">
        <span>Plate image</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageChange} />
      </label>

      {showCameraCapture ? (
        <div className="camera-capture-control">
          <div className="camera-capture-row">
            <span className="camera-capture-label">Acquire image</span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void startCamera();
              }}
            >
              Start camera
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!cameraActive}
              onClick={handleCaptureImage}
            >
              Capture
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!cameraActive}
              onClick={stopCamera}
            >
              Stop
            </button>
          </div>

          {cameraDevices.length > 1 ? (
            <label className="camera-device-control">
              <span>Camera</span>
              <select value={selectedCameraId} onChange={handleCameraSelectionChange}>
                {cameraDevices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {cameraActive ? (
            <video
              ref={videoRef}
              className="camera-preview"
              playsInline
              muted
            />
          ) : (
            <video
              ref={videoRef}
              className="camera-preview camera-preview-hidden"
              playsInline
              muted
            />
          )}

          {cameraStatus ? <p className="file-name">{cameraStatus}</p> : null}
        </div>
      ) : null}

      <p className="file-name">{imageName ?? 'No image selected'}</p>

      {showGeometryUpload ? (
        <>
          <label className="file-control">
            <span>Geometry JSON</span>
            <input type="file" accept="application/json,.json" onChange={handleGeometryChange} />
          </label>
          <p className="file-name">{geometryName ?? 'No geometry selected'}</p>
        </>
      ) : null}
    </section>
  );
}
