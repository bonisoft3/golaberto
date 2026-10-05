"""Normalize data-owned zone colors and explicit finishing-position lists."""
import re


def color(value):
    value = str(value).strip().lower()
    # The legacy archive uses this CSS name alongside hex literals.
    if value == 'lightgreen':
        return '#90ee90'
    if re.fullmatch(r'#[0-9a-f]{3}', value):
        return '#' + ''.join(c * 2 for c in value[1:])
    if not re.fullmatch(r'#[0-9a-f]{6}', value):
        raise ValueError(f'invalid zone color: {value!r}')
    return value


def positions(zone):
    values = zone.get('positions', zone.get('position'))
    if values is None:
        values = list(range(zone['first'], zone['last'] + 1))
    if not isinstance(values, list) or not values or any(type(p) is not int or not 1 <= p <= 2147483647 for p in values):
        raise ValueError('zone positions must be a nonempty positive integer list')
    if len(values) != len(set(values)):
        raise ValueError('zone positions must be unique')
    return sorted(values)
