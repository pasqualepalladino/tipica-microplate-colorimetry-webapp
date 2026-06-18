import type { ChangeEvent } from 'react';
import { parseGeometryJson } from '../core/geometry';
import type { PlateGeometry } from '../types/geometry';

interface ImageGeometryLoaderProps {
  imageName: string | null;
  geometryName: string | null;
  onImageLoaded: (image: HTMLImageElement, fileName: string) => void;
  onGeometryLoaded: (geometry: PlateGeometry, fileName: string) => void;
  onError: (message: string) => void;
}

export function ImageGeometryLoader({
  imageName,
  geometryName,
  onImageLoaded,
  onGeometryLoaded,
  onError,
}: ImageGeometryLoaderProps) {
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

  return (
    <section className="control-section" aria-labelledby="loader-heading">
      <h2 id="loader-heading">Files</h2>

      <label className="file-control">
        <span>Plate image</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageChange} />
      </label>
      <p className="file-name">{imageName ?? 'No image selected'}</p>

      <label className="file-control">
        <span>Geometry JSON</span>
        <input type="file" accept="application/json,.json" onChange={handleGeometryChange} />
      </label>
      <p className="file-name">{geometryName ?? 'No geometry selected'}</p>
    </section>
  );
}
