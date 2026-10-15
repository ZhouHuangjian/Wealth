import copy
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal as D
from types import SimpleNamespace as S
from unittest.mock import patch
import django
django.setup()
from wealth.daily_returns import convert_return_currency
from wealth.fund_return_updates import _holding_update
DAY=date(2026,10,13)
NOW=datetime(2026,10,13,11,40,tzinfo=timezone.utc)
KEY=('public-synthetic-account','public-synthetic-instrument')
ACCOUNT=S(pk=KEY[0],name='synthetic account',valuation_mode='positions')
PRODUCT=S(pk=KEY[1],code='017641',currency='CNY',name='synthetic fund',kind='fund')
def build():
    reference={'kind':'reference_estimate','code':'017641','currency':'CNY','base_nav':'1.7237','base_nav_date':'2026-10-12','price':'1.7203','published_at':'2026-10-13T05:04:00+08:00','fetched_at':NOW.isoformat(),'source':'synthetic independent source','base_ratio_consistent':False}
    formal=[S(economic_date=date(2026,10,9),value=D('1.7251'),source='synthetic formal',published_at=None,created_at=NOW),S(economic_date=date(2026,10,12),value=D('1.7237'),source='synthetic formal',published_at=None,created_at=NOW)]
    recent={'amount':D('-0.140000000000000000000000000000000000'),'basis':D('172.5100000000000000000000000000'),'return_rate':D('-0.14')/D('172.51'),'nav_date':date(2026,10,12),'interval_start':date(2026,10,9),'quantity_source':'automatic_estimate','contains_automatic_estimates':True}
    evidence=S(accounts={KEY[0]:ACCOUNT},instruments={KEY[1]:PRODUCT},states={KEY[1]:{'refresh_status':'ready'}},movements={KEY:[{'date':date(2026,10,8),'quantity':D('100')}]},space=S(timezone='Asia/Shanghai'),formal={KEY[1]:formal},nav_quarantines=defaultdict(dict),dividends=defaultdict(list),actions={},read_check=lambda *args:None)
    return evidence,reference,{KEY:{'latest_confirmed_return':recent}}
def calculate(evidence,reference,holdings):
    with patch('wealth.fund_return_updates.timezone.now',return_value=NOW),patch('wealth.fund_return_updates.has_automatic_shares',return_value=False):
        return _holding_update(evidence,KEY,reference,DAY,holdings)
def verify(name,setup,assertion):
    e,r,h=build()
    setup(e,r,h)
    before=copy.deepcopy((r,h,e.movements))
    row=calculate(e,r,h)
    assertion(row)
    assert (r,h,e.movements)==before,'unexpected input mutation'
    print('PASS:',name)
def formal(row):
    assert row['status']=='formal' and row['amount']==D('-.14')
    assert row['date']==row['nav_date']==row['return_date']==date(2026,10,12)
    assert row['reference_unavailable_reason_code']=='reference_baseline'
    assert row['missing_reason_code'] is None
verify('changed source baseline falls back to native Decimal formal return at NAV date',lambda *args:None,formal)
verify('invalid date cannot 500 or create estimate',lambda e,r,h:r.update(base_nav_date='2026-02-30'),formal)
def missing(row):
    assert row['amount'] is None and row['status']=='unavailable'
verify('reference identity is never bypassed',lambda e,r,h:r.update(code='019305'),missing)
verify('other account result is never borrowed',lambda e,r,h:h.update({('other-account',KEY[1]):h.pop(KEY)}),missing)
verify('other product result is never borrowed',lambda e,r,h:h.update({(KEY[0],'other-product'):h.pop(KEY)}),missing)
verify('older formal result never relabelled to newer NAV',lambda e,r,h:h[KEY]['latest_confirmed_return'].update(nav_date=date(2026,10,9)),missing)
verify('missing formal amount remains missing',lambda e,r,h:h[KEY]['latest_confirmed_return'].update(amount=None),missing)
def zero(row):
    assert row['status']=='formal' and row['amount']==0
    assert row['quantity_source']=='automatic_estimate' and row['contains_automatic_estimates'] is True
verify('zero with 36 Decimal places and inferred-share provenance is retained',lambda e,r,h:h[KEY]['latest_confirmed_return'].update(amount=D('0.000000000000000000000000000000000000')),zero)
def estimated(row):
    assert row['status']=='estimated' and row['amount']==D('-.34')
    assert row['nav_date'] is row['return_date'] is None
    assert 'reference_unavailable_reason_code' not in row
verify('valid new reference retains priority over formal baseline',lambda e,r,h:r.update(base_ratio_consistent=True),estimated)
def blocked(code):
    def check(row):
        missing(row)
        assert row['missing_reason_code']==code
    return check
verify('conflict inside formal interval before reference base is not bypassed',lambda e,r,h:e.nav_quarantines[KEY[1]].update({'2026-10-10':{'status':'conflict'}}),blocked('nav_conflict'))
verify('same-day known conflict is not bypassed',lambda e,r,h:e.nav_quarantines[KEY[1]].update({'2026-10-12':{'status':'conflict'}}),blocked('nav_conflict'))
verify('unverified movement date blocks formal fallback',lambda e,r,h:e.movements[KEY][0].update(date_error='unverified'),blocked('trade_date_unverified'))
verify('unresolved current holding scope blocks formal fallback',lambda e,r,h:setattr(e,'read_check',lambda *args:{'status':'unresolved'}),blocked('holding_reconciliation'))
e,r,h=build()
row=calculate(e,r,h)
missingfx=convert_return_currency(row,'USD',[])
assert missingfx['status']=='unavailable' and missingfx['native_status']=='formal'
assert missingfx['amount']==D('-.14') and missingfx['base_amount'] is None
assert missingfx['reference_unavailable_reason_code']=='reference_baseline'
print('PASS: missing FX preserves native formal amount and reference rejection reason')
fx=[S(base='CNY',quote='USD',economic_date=date(2026,10,13),rate=D('.2'),source='future'),S(base='CNY',quote='USD',economic_date=date(2026,10,12),rate=D('.14'),source='applicable')]
converted=convert_return_currency(row,'USD',fx)
assert converted['base_amount']==D('-.0196') and converted['fx_date']==date(2026,10,12)
print('PASS: formal fallback FX uses NAV day, not fetch/view day')
print('RESULT: 15 pure checks passed; no DB or network calls')
