import { useEffect, useRef, useState } from 'react';
import { wgs84ToGcj02 } from '../domain/maps';
import type { CountryCode, Locale } from '../domain/types';

interface AMapInstance {
  add: (value: unknown) => void;
  destroy: () => void;
}

interface AMapNamespace {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AMapInstance;
  Marker: new (options: Record<string, unknown>) => unknown;
}

declare global {
  interface Window {
    AMap?: AMapNamespace;
    _AMapSecurityConfig?: { serviceHost: string };
  }
}

let loader: { key: string; serviceHost: string; promise: Promise<AMapNamespace> } | undefined;

export const resolveAmapServiceHost = (serviceHost: string, currentOrigin = window.location.origin): string => {
  const page = new URL(currentOrigin);
  const resolved = new URL(serviceHost, `${page.origin}/`);
  const localDevelopment = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(resolved.hostname);
  if (resolved.origin !== page.origin || resolved.username || resolved.password
    || (resolved.protocol !== 'https:' && !(resolved.protocol === 'http:' && localDevelopment))
    || resolved.pathname.replace(/\/+$/u, '') !== '/_AMapService' || resolved.search || resolved.hash) {
    throw new Error('INVALID_AMAP_SERVICE_HOST');
  }
  return `${resolved.origin}/_AMapService`;
};

const loadAmap = (key: string, serviceHost: string): Promise<AMapNamespace> => {
  const absoluteServiceHost = resolveAmapServiceHost(serviceHost);
  if (window.AMap) return Promise.resolve(window.AMap);
  if (loader?.key === key && loader.serviceHost === absoluteServiceHost) return loader.promise;
  const promise = new Promise<AMapNamespace>((resolve, reject) => {
    window._AMapSecurityConfig = { serviceHost: absoluteServiceHost };
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.dataset.addressAmap = 'true';
    script.onload = () => window.AMap ? resolve(window.AMap) : reject(new Error('AMAP_NOT_READY'));
    script.onerror = () => reject(new Error('AMAP_LOAD_FAILED'));
    document.head.append(script);
  });
  loader = { key, serviceHost: absoluteServiceHost, promise };
  void promise.catch(() => {
    if (loader?.promise === promise) loader = undefined;
  });
  return promise;
};

export default function AmapPreview({
  apiKey, serviceHost, countryCode, latitude, longitude, label, locale, errorText
}: {
  apiKey: string;
  serviceHost: string;
  countryCode: CountryCode;
  latitude: number;
  longitude: number;
  label: string;
  locale: Locale;
  errorText: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let map: AMapInstance | undefined;
    setError(false);
    const coordinates = countryCode === 'CN'
      ? wgs84ToGcj02({ latitude, longitude })
      : { latitude, longitude };
    void loadAmap(apiKey, serviceHost).then((AMap) => {
      if (disposed || !container.current) return;
      map = new AMap.Map(container.current, {
        viewMode: '2D',
        zoom: 17,
        center: [coordinates.longitude, coordinates.latitude],
        showOversea: countryCode !== 'CN',
        lang: locale === 'en' ? 'en' : 'zh_cn'
      });
      map.add(new AMap.Marker({
        position: [coordinates.longitude, coordinates.latitude],
        title: label
      }));
    }).catch(() => {
      if (!disposed) setError(true);
    });
    return () => {
      disposed = true;
      map?.destroy();
    };
  }, [apiKey, serviceHost, countryCode, latitude, longitude, label, locale]);

  return <div className="map-frame amap-frame" data-map-provider="amap">
    <div ref={container} className="amap-container" />
    {error && <div className="map-error" role="status">{errorText}</div>}
  </div>;
}
