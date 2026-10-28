/**
 * おすすめリスト連携 – BookState シート同期
 * B列にはオブジェクトを JSON.stringify した文字列で保存する
 */
const SHEET_NAME_DEFAULT = 'BookState';

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** ?sheet= または POST ボディの _sheet でシート名を切り替え */
function resolveSheetName_(e, incoming) {
  if (incoming && typeof incoming._sheet === 'string' && incoming._sheet.trim()) {
    return incoming._sheet.trim();
  }
  if (e && e.parameter && e.parameter.sheet) {
    return String(e.parameter.sheet).trim();
  }
  return SHEET_NAME_DEFAULT;
}

function getOrCreateSheet_(name) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['key', 'value']);
  } else {
    const range = sh.getDataRange();
    if (range.getNumRows() < 1 || sh.getRange(1, 1).getValue() !== 'key') {
      sh.clear();
      sh.appendRow(['key', 'value']);
    }
  }
  return sh;
}

function res_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * B列の値をクライアント用に復元（JSON文字列ならパース、それ以外はそのまま）
 */
function cellToValue_(cell) {
  if (cell === '' || cell === null || cell === undefined) return '';
  if (typeof cell === 'object' && !(cell instanceof Date)) {
    return cell;
  }
  const s = String(cell).trim();
  if (!s) return '';
  if ((s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') ||
      (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']')) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return s;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!isNaN(n)) return n;
  }
  return s;
}

/**
 * シートに書く B列用の文字列（オブジェクト・配列は JSON.stringify）
 */
function valueToCellString_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function doGet(e) {
  try {
    const name = resolveSheetName_(e, null);
    const sheet = getOrCreateSheet_(name);
    const rows = sheet.getDataRange().getValues();
    const state = {};

    for (var i = 1; i < rows.length; i++) {
      var key = rows[i][0];
      if (key === '' || key === null || key === undefined) continue;
      var raw = rows[i][1];
      state[String(key)] = cellToValue_(raw);
    }
    return res_(state);
  } catch (err) {
    return res_({ error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return res_({ error: 'no post body' });
    }

    var incoming = JSON.parse(e.postData.contents);

    // お店の座標・営業時間（ShopPlaces）系のリクエストはここで必ず return する。
    // 下の BookState 上書き処理には絶対に流さない。
    if (incoming && incoming._action !== undefined) {
      return res_(handlePlacesAction_(incoming));
    }

    var sheetName = resolveSheetName_(e, incoming);
    var sheet = getOrCreateSheet_(sheetName);

    var incomingTs = Number(incoming._ts) || 0;

    var rows = sheet.getDataRange().getValues();
    var cloudTs = 0;
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]) === '_ts') {
        var parsed = cellToValue_(rows[r][1]);
        cloudTs = Number(parsed) || 0;
        break;
      }
    }

    if (cloudTs > incomingTs) {
      return res_({
        status: 'rejected',
        reason: 'cloud is newer',
        cloudTs: cloudTs,
        incomingTs: incomingTs
      });
    }

    var out = [['key', 'value']];
    var keys = Object.keys(incoming);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key === '_sheet') continue;
      out.push([key, valueToCellString_(incoming[key])]);
    }

    sheet.clearContents();
    if (out.length > 0) {
      sheet.getRange(1, 1, out.length, 2).setValues(out);
    }

    return res_({ status: 'ok', sheet: sheetName, rows: out.length - 1, ts: incomingTs });
  } catch (err) {
    return res_({ error: String(err.message || err) });
  }
}


/* ══════════════════════════════════════════════════════
   お店の座標・営業時間（Google Places API (New)）
   ─ 結果は ShopPlaces シートに保存（BookState とは完全に別）
   ─ APIキーはスクリプトプロパティ PLACES_API_KEY から読む
══════════════════════════════════════════════════════ */
const PLACES_SHEET_NAME = 'ShopPlaces';
const PLACES_HEADER = [
  'key', 'placeId', 'googleName', 'googleAddress', 'lat', 'lng', 'status',
  'query', 'manual', 'placeFetchedAt', 'hoursJson', 'hoursFetchedAt',
  'regularHoursJson', 'hoursError'   // 後から追加した列（既存列の並びは変えない）
];
const MAX_SEARCH_PER_CALL = 20;   // 1回の呼び出しで Text Search する最大件数
const MAX_DETAILS_PER_CALL = 20;  // 1回の呼び出しで営業時間を再取得する最大件数（近い順）
const MAX_SHOPS_PER_CALL = 2000;  // 受け付けるお店一覧の上限
const HOURS_TTL_MS = 24 * 60 * 60 * 1000;
// 場所を特定できない住所（検索しない）
const SKIP_ADDRESS_RE = /デリバリー|全国チェーン|全国展開|オンライン|通販/;
// 検索フィールド（料金を抑えるため必要な項目だけ）
const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location';
// currentOpeningHours（臨時休業・祝日を反映した直近7日分）と regularOpeningHours（毎週の通常営業）は同じ料金区分
const DETAILS_FIELD_MASK = 'currentOpeningHours,regularOpeningHours';

/** _action ごとの振り分け（未知の _action もエラーで返し、BookState 処理には流さない） */
function handlePlacesAction_(incoming) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { error: 'busy' };
  try {
    if (incoming._action === 'placesList') return placesList_(incoming);
    if (incoming._action === 'placesRefetch') return placesRefetch_(incoming);
    return { error: 'unknown action' };
  } catch (err) {
    return { error: String(err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function getPlacesApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('PLACES_API_KEY');
  if (!key) throw new Error('PLACES_API_KEY が未設定です');
  return key;
}

function getOrCreatePlacesSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(PLACES_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(PLACES_SHEET_NAME);
    sh.getRange(1, 1, 1, PLACES_HEADER.length).setValues([PLACES_HEADER]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** ShopPlaces 全行を { key: record } で読む */
function readPlaces_(sheet) {
  var rows = sheet.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var rec = {};
    for (var c = 0; c < PLACES_HEADER.length; c++) rec[PLACES_HEADER[c]] = rows[i][c];
    if (!rec.key) continue;
    rec.key = String(rec.key);
    rec.lat = rec.lat === '' ? null : Number(rec.lat);
    rec.lng = rec.lng === '' ? null : Number(rec.lng);
    rec.manual = rec.manual === true || rec.manual === 'TRUE';
    rec.placeFetchedAt = Number(rec.placeFetchedAt) || 0;
    rec.hoursFetchedAt = Number(rec.hoursFetchedAt) || 0;
    map[rec.key] = rec;
  }
  return map;
}

/** ShopPlaces 全行を書き戻す（ヘッダーは維持） */
function writePlaces_(sheet, map) {
  var keys = Object.keys(map).sort();
  var out = keys.map(function (k) {
    var rec = map[k];
    return PLACES_HEADER.map(function (h) {
      var v = rec[h];
      return (v === null || v === undefined) ? '' : v;
    });
  });
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, PLACES_HEADER.length).clearContent();
  sheet.getRange(1, 1, 1, PLACES_HEADER.length).setValues([PLACES_HEADER]);
  if (out.length) {
    // placeId・query などが数値や日付に自動変換されないよう文字列書式に
    sheet.getRange(2, 1, out.length, 4).setNumberFormat('@');
    sheet.getRange(2, 8, out.length, 1).setNumberFormat('@');
    sheet.getRange(2, 11, out.length, 1).setNumberFormat('@');
    sheet.getRange(2, 13, out.length, 2).setNumberFormat('@');
    sheet.getRange(2, 1, out.length, PLACES_HEADER.length).setValues(out);
  }
}

function buildQuery_(shop) {
  return (String(shop.name || '') + ' ' + String(shop.address || '')).trim();
}

/** 入力のお店一覧を検証・正規化 */
function normalizeShops_(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length && out.length < MAX_SHOPS_PER_CALL; i++) {
    var s = list[i] || {};
    var key = String(s.key || '');
    if (!/^i_\d+$/.test(key)) continue;
    out.push({
      key: key,
      name: String(s.name || '').slice(0, 100),
      address: String(s.address || '').slice(0, 200)
    });
  }
  return out;
}

/** このお店を（再）検索すべきか */
function needsSearch_(shop, rec) {
  if (!rec) return true;
  if (rec.status === 'ERROR') return true;
  // 手動で検索語を指定したものは自動で上書きしない
  if (rec.manual) return false;
  // 店名・住所が編集されていたら再検索
  return rec.query !== buildQuery_(shop);
}

function searchRequest_(apiKey, query) {
  return {
    url: 'https://places.googleapis.com/v1/places:searchText',
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': SEARCH_FIELD_MASK },
    payload: JSON.stringify({ textQuery: query, languageCode: 'ja', regionCode: 'JP', pageSize: 1 }),
    muteHttpExceptions: true
  };
}

function detailsRequest_(apiKey, placeId) {
  return {
    url: 'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId) + '?languageCode=ja',
    method: 'get',
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAILS_FIELD_MASK },
    muteHttpExceptions: true
  };
}

/** 営業時間キャッシュを捨てる（別の店に変わった・見つからなかったとき） */
function clearHours_(rec) {
  rec.hoursJson = '';
  rec.regularHoursJson = '';
  rec.hoursFetchedAt = 0;
  rec.hoursError = '';
}

/** Text Search の結果を record に反映（response は通信失敗時 Error） */
function applySearchResult_(rec, response, now) {
  rec.placeFetchedAt = now;
  if (response instanceof Error || response.getResponseCode() !== 200) {
    rec.status = 'ERROR';
    return;
  }
  var body = JSON.parse(response.getContentText() || '{}');
  var p = body.places && body.places[0];
  if (!p || !p.location) {
    rec.status = 'NOT_FOUND';
    rec.placeId = '';
    rec.googleName = '';
    rec.googleAddress = '';
    rec.lat = null;
    rec.lng = null;
    clearHours_(rec);
    return;
  }
  // 別の店に変わったら営業時間キャッシュは捨てる
  if (rec.placeId !== p.id) clearHours_(rec);
  rec.status = 'OK';
  rec.placeId = p.id;
  rec.googleName = (p.displayName && p.displayName.text) || '';
  rec.googleAddress = p.formattedAddress || '';
  rec.lat = p.location.latitude;
  rec.lng = p.location.longitude;
}

/**
 * Place Details の結果を record に反映（response は通信失敗時 Error）
 * 失敗時は古いキャッシュを残し、hoursFetchedAt を更新しない（次回に再取得）。原因は hoursError に記録
 */
function applyDetailsResult_(rec, response, now) {
  var stamp = Utilities.formatDate(new Date(now), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  if (response instanceof Error) {
    rec.hoursError = stamp + ' 通信エラー: ' + String(response.message || response).slice(0, 200);
    return;
  }
  var code = response.getResponseCode();
  var body = {};
  try { body = JSON.parse(response.getContentText() || '{}'); } catch (e) {}
  if (code !== 200) {
    var msg = body.error ? (body.error.status || '') + ' ' + (body.error.message || '') : '';
    rec.hoursError = (stamp + ' HTTP ' + code + ' ' + msg).trim().slice(0, 300);
    return;
  }
  var cur = body.currentOpeningHours;
  var reg = body.regularOpeningHours;
  // currentOpeningHours があって periods が空 = 直近7日は営業なし（臨時休業など）として [] を保存
  rec.hoursJson = cur ? JSON.stringify(cur.periods || []) : '';
  rec.regularHoursJson = reg && reg.periods ? JSON.stringify(reg.periods) : '';
  rec.hoursFetchedAt = now;
  rec.hoursError = '';
}

/** 1件取得。通信失敗（DNS・タイムアウト等）は例外ではなく Error を返す */
function fetchOne_(req) {
  try {
    return UrlFetchApp.fetch(req.url, req);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** 並列取得。fetchAll 自体が失敗したら1件ずつ取り直し、失敗分は Error を返す */
function fetchAllSafe_(reqs) {
  try {
    return UrlFetchApp.fetchAll(reqs);
  } catch (e) {
    return reqs.map(fetchOne_);
  }
}

function distanceKm_(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** クライアントへ返す形 */
function parseJsonOrNull_(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function toClientPlace_(rec) {
  return {
    placeId: rec.placeId || '',
    googleName: rec.googleName || '',
    googleAddress: rec.googleAddress || '',
    lat: rec.lat,
    lng: rec.lng,
    status: rec.status || '',
    manual: !!rec.manual,
    periods: parseJsonOrNull_(rec.hoursJson),               // currentOpeningHours（日付付き・直近7日）
    regularPeriods: parseJsonOrNull_(rec.regularHoursJson), // regularOpeningHours（毎週の通常営業）
    hoursFetchedAt: rec.hoursFetchedAt || 0,
    hoursError: rec.hoursError || ''
  };
}

/**
 * placesList
 * 入力: { _action:'placesList', shops:[{key,name,address}], lat?, lng? }
 * 1. ShopPlaces に無い／住所が変わったお店を Text Search（最大20件・並列）
 * 2. lat/lng があれば近い順上位20件のうち、営業時間が24時間以上古いものだけ Details（並列）
 * 3. 渡された全店の結果を返す。pending = まだ検索していない件数
 */
function placesList_(incoming) {
  var shops = normalizeShops_(incoming.shops);
  var sheet = getOrCreatePlacesSheet_();
  var map = readPlaces_(sheet);
  var now = Date.now();
  var changed = false;
  var apiKey = null;

  // ① 座標の未取得・住所変更のお店を検索
  var toSearch = [];
  var pending = 0;
  shops.forEach(function (shop) {
    var rec = map[shop.key];
    if (!needsSearch_(shop, rec)) return;
    var query = buildQuery_(shop);
    if (!shop.address || SKIP_ADDRESS_RE.test(shop.address)) {
      if (!rec || rec.status !== 'SKIPPED' || rec.query !== query) {
        map[shop.key] = { key: shop.key, status: 'SKIPPED', query: query, manual: false, placeFetchedAt: now };
        changed = true;
      }
      return;
    }
    if (toSearch.length < MAX_SEARCH_PER_CALL) toSearch.push({ shop: shop, query: query });
    else pending++;
  });

  if (toSearch.length) {
    apiKey = apiKey || getPlacesApiKey_();
    var sRes = fetchAllSafe_(toSearch.map(function (t) { return searchRequest_(apiKey, t.query); }));
    toSearch.forEach(function (t, i) {
      var rec = map[t.shop.key] || { key: t.shop.key };
      rec.query = t.query;
      rec.manual = false;
      applySearchResult_(rec, sRes[i], now);
      map[t.shop.key] = rec;
    });
    changed = true;
  }

  // ② 近い順上位20件だけ、古い営業時間を再取得
  var lat = Number(incoming.lat);
  var lng = Number(incoming.lng);
  if (incoming.lat !== undefined && incoming.lng !== undefined && isFinite(lat) && isFinite(lng)) {
    var near = shops
      .map(function (s) { return map[s.key]; })
      .filter(function (rec) { return rec && rec.status === 'OK' && rec.placeId && rec.lat !== null && rec.lng !== null; })
      .map(function (rec) { return { rec: rec, d: distanceKm_(lat, lng, rec.lat, rec.lng) }; })
      .sort(function (a, b) { return a.d - b.d; })
      .slice(0, MAX_DETAILS_PER_CALL)
      .filter(function (x) { return now - x.rec.hoursFetchedAt >= HOURS_TTL_MS; });

    if (near.length) {
      apiKey = apiKey || getPlacesApiKey_();
      var dRes = fetchAllSafe_(near.map(function (x) { return detailsRequest_(apiKey, x.rec.placeId); }));
      near.forEach(function (x, i) { applyDetailsResult_(x.rec, dRes[i], now); });
      changed = true;
    }
  }

  if (changed) writePlaces_(sheet, map);

  var places = {};
  shops.forEach(function (s) {
    if (map[s.key]) places[s.key] = toClientPlace_(map[s.key]);
  });
  return { status: 'ok', places: places, pending: pending };
}

/**
 * placesRefetch（別の店がヒットしていたときの再取得）
 * 入力: { _action:'placesRefetch', key, name, address, query? }
 * query を指定すると手動扱い（以後、自動再検索で上書きしない）
 */
function placesRefetch_(incoming) {
  var shop = normalizeShops_([incoming])[0];
  if (!shop) return { error: 'invalid key' };
  var custom = String(incoming.query || '').trim().slice(0, 200);
  var query = custom || buildQuery_(shop);
  if (!query) return { error: 'empty query' };

  var sheet = getOrCreatePlacesSheet_();
  var map = readPlaces_(sheet);
  var now = Date.now();
  var apiKey = getPlacesApiKey_();
  var rec = map[shop.key] || { key: shop.key };

  rec.query = query;
  rec.manual = !!custom;
  applySearchResult_(rec, fetchOne_(searchRequest_(apiKey, query)), now);
  if (rec.status === 'OK') {
    applyDetailsResult_(rec, fetchOne_(detailsRequest_(apiKey, rec.placeId)), now);
  }
  map[shop.key] = rec;
  writePlaces_(sheet, map);
  return { status: 'ok', key: shop.key, place: toClientPlace_(rec) };
}

/**
 * 【GASエディタから手動実行】APIキーと権限の確認用
 * 実行ログに Google 上の店名・営業時間の有無が出れば OK（ShopPlaces には書き込まない）
 */
function testPlacesApi() {
  var apiKey = getPlacesApiKey_();
  var s = fetchOne_(searchRequest_(apiKey, '渋谷駅'));
  if (s instanceof Error) { Logger.log('Text Search: ' + s.message); return; }
  Logger.log('Text Search: ' + s.getResponseCode() + ' ' + s.getContentText().slice(0, 500));
  if (s.getResponseCode() !== 200) return;
  var p = JSON.parse(s.getContentText()).places[0];
  var d = fetchOne_(detailsRequest_(apiKey, p.id));
  if (d instanceof Error) { Logger.log('Details: ' + d.message); return; }
  Logger.log('Details: ' + d.getResponseCode() + ' ' + d.getContentText().slice(0, 500));
}

