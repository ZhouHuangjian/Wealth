import io
import zipfile
import pytest
from openpyxl import Workbook
from wealth.imports import parse_file
from wealth.common import DomainError


def test_malformed_or_ambiguous_csv_rejected():
    for content in [
        b"date,amount,amount\n2026-01-01,1,1",
        b"date,amount\n2026-01-01,1,unexpected",
        b"\x00\x00bad",
    ]:
        with pytest.raises(DomainError):
            parse_file(content, "source.csv")


def test_xlsx_formula_is_not_executed_or_silently_cached():
    book = Workbook()
    sheet = book.active
    sheet.append(["date", "amount"])
    sheet.append(["2026-01-01", "=1+2"])
    data = io.BytesIO()
    book.save(data)
    with pytest.raises(DomainError, match="公式"):
        parse_file(data.getvalue(), "formula.xlsx")


def test_xlsx_compression_bomb_rejected_before_reading_cells():
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b"A" * 500000)
    with pytest.raises(DomainError, match="压缩比例"):
        parse_file(data.getvalue(), "source.xlsx")


def test_chinese_csv_preamble_and_gb18030_encoding():
    content = "交易说明\n导出文件\n交易日期,金额,收/支,备注\n2026-01-01,12.30,支出,交通\n".encode(
        "gb18030"
    )
    headers, rows = parse_file(content, "source.csv")
    assert rows[0][0] == 4
    assert rows[0][1]["金额"] == "12.30"
    assert rows[0][1]["备注"] == "交通"
