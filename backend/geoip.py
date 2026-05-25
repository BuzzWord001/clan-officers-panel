"""Резолв страны по IP через ip-api.com batch (free, 45 req/min).

Кэш в БД таблице geoip_cache — повторно один и тот же IP не дёргает API.
Все вызовы фронта проходят через /admin/resolve-ips, который сначала
дёргает кэш, потом для непокрытых делает один bulk-запрос.
"""

import ipaddress
import logging
from typing import Any

import httpx

import db

log = logging.getLogger("officers.geoip")

# ip-api.com batch принимает до 100 IP за один POST. fields= ограничивает
# набор полей в ответе (меньше JSON = меньше латенси).
_BATCH_URL = "http://ip-api.com/batch?fields=status,country,countryCode,regionName,city,isp,query"
_MAX_BATCH = 100
_TIMEOUT = 10.0


def _is_routable(ip: str) -> bool:
    """Локальные/частные/loopback IP не имеют смысла резолвить."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_multicast or addr.is_reserved or addr.is_unspecified)


async def resolve(ips: list[str]) -> dict[str, dict[str, Any]]:
    """Возвращает {ip: {country, country_code, region, city, isp}} для каждого
    IP. Сначала кэш, потом для непокрытых — один batch-запрос."""
    ips = list({ip for ip in ips if ip and _is_routable(ip)})
    if not ips:
        return {}

    cached = db.get_geoip_cached(ips)
    pending = [ip for ip in ips if ip not in cached]
    result: dict[str, dict[str, Any]] = dict(cached)

    if not pending:
        return result

    # Один batch на 100 IP за раз. На больших списках режем.
    for chunk_start in range(0, len(pending), _MAX_BATCH):
        chunk = pending[chunk_start:chunk_start + _MAX_BATCH]
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.post(_BATCH_URL, json=chunk)
                items = r.json()
        except Exception as exc:
            log.warning("ip-api batch failed: %s", exc)
            continue

        for ip, item in zip(chunk, items):
            if not isinstance(item, dict):
                continue
            if item.get("status") != "success":
                continue
            country = item.get("country") or ""
            country_code = item.get("countryCode") or ""
            region = item.get("regionName") or ""
            city = item.get("city") or ""
            isp = item.get("isp") or ""
            try:
                db.upsert_geoip(
                    ip, country=country, country_code=country_code,
                    region=region, city=city, isp=isp,
                )
            except Exception:
                log.exception("upsert_geoip failed for %s", ip)
            result[ip] = {
                "ip": ip,
                "country": country,
                "country_code": country_code,
                "region": region,
                "city": city,
                "isp": isp,
            }
    return result
