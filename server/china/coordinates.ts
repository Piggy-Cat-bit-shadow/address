const pi = Math.PI;
const a = 6378245;
const ee = 0.006693421622965943;

const outsideChina = (latitude: number, longitude: number): boolean => longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
const transformLatitude = (x: number, y: number): number => {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  value += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
  value += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  return value;
};
const transformLongitude = (x: number, y: number): number => {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  value += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
  value += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
  return value;
};

export const wgs84ToGcj02 = (latitude: number, longitude: number): [number, number] => {
  if (outsideChina(latitude, longitude)) return [latitude, longitude];
  let deltaLatitude = transformLatitude(longitude - 105, latitude - 35);
  let deltaLongitude = transformLongitude(longitude - 105, latitude - 35);
  const radLatitude = latitude / 180 * pi;
  let magic = Math.sin(radLatitude);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  deltaLatitude = deltaLatitude * 180 / ((a * (1 - ee)) / (magic * sqrtMagic) * pi);
  deltaLongitude = deltaLongitude * 180 / (a / sqrtMagic * Math.cos(radLatitude) * pi);
  return [latitude + deltaLatitude, longitude + deltaLongitude];
};

export const gcj02ToWgs84 = (latitude: number, longitude: number): [number, number] => {
  const [gcjLatitude, gcjLongitude] = wgs84ToGcj02(latitude, longitude);
  return [latitude * 2 - gcjLatitude, longitude * 2 - gcjLongitude];
};

export const bd09ToGcj02 = (latitude: number, longitude: number): [number, number] => {
  const x = longitude - 0.0065;
  const y = latitude - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * 3000 / 180 * pi);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * 3000 / 180 * pi);
  return [z * Math.sin(theta), z * Math.cos(theta)];
};

export const bd09ToWgs84 = (latitude: number, longitude: number): [number, number] => {
  const [gcjLatitude, gcjLongitude] = bd09ToGcj02(latitude, longitude);
  return gcj02ToWgs84(gcjLatitude, gcjLongitude);
};

export const distanceMeters = (left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number => {
  const radians = pi / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};
