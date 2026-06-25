import openpyxl, os, sys
from copy import copy
from openpyxl.styles import PatternFill, Font, Color
from openpyxl.drawing.image import Image as XLImage
NAVY='FF1F4E78'; BLACK='FF000000'; YELLOW='FFFFD700'; WHITE='FFFFFFFF'
LOGO='/Users/cindyeagar/pnthr100-scanner/client/src/assets/panther-head-sm.png'
DISCLAIMER=('Disclaimer:\n\nThese statements are prepared and provided by PNTHR Funds, LLC, the General Partner of the Fund, '
 'solely for informational purposes. The figures are unaudited estimates as of the reporting date and are subject to change; '
 'they are superseded by the Fund’s audited annual financial statements. This information is confidential, intended only for the '
 'named investor, and may not be redistributed. It does not constitute an offer, solicitation, or tax, legal, or investment advice. '
 'Past performance is not necessarily indicative of future results.')
REPL=[('NAV Fund Services','PNTHR Funds, LLC'),('NAV Fund Service','PNTHR Funds, LLC'),('NAV Consulting, Inc.','PNTHR Funds, LLC'),
 ('NAV Consulting','PNTHR Funds, LLC'),('NAV Fund Administration Group','PNTHR Funds, LLC'),(' (NAV)',''),('used by NAV to','used to'),
 ('navfundservices.com','pnthrfunds.com'),('navconsulting.net','pnthrfunds.com')]
def fix_text(v):
    if not isinstance(v,str) or 'NAV' not in v: return v
    if v.strip().startswith('Disclaimer'): return DISCLAIMER
    for a,b in REPL: v=v.replace(a,b)
    return v.replace('NAV','PNTHR')
def set_font(cell, rgb, bold=None):
    f=cell.font; cell.font=Font(name=f.name, size=f.size, bold=(f.bold if bold is None else bold),
        italic=f.italic, color=Color(rgb=rgb))
def rebrand(infile, outfile, kind):
    wb=openpyxl.load_workbook(infile)
    for ws in wb.worksheets:
        ws._images=[]
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value,str) and 'NAV' in c.value:
                    c.value=fix_text(c.value)
                try:
                    solid = c.fill and c.fill.fill_type=='solid' and c.fill.fgColor and c.fill.fgColor.rgb
                    if solid==NAVY:
                        c.fill=PatternFill(start_color=BLACK,end_color=BLACK,fill_type='solid')
                        set_font(c, YELLOW)              # band text -> yellow
                    elif c.font and c.font.color and c.font.color.rgb==NAVY:
                        set_font(c, BLACK)               # navy heading on white -> black
                except Exception: pass
        # notebook/caproll lost their image band -> build a black band (rows 1-2) w/ yellow fund name
        if kind in ('notebook','caproll'):
            maxc=min(max(ws.max_column,1),40)
            for r in (1,2):
                for cc in range(1,maxc+1):
                    ws.cell(r,cc).fill=PatternFill(start_color=BLACK,end_color=BLACK,fill_type='solid')
            ws.row_dimensions[1].height=24
            if isinstance(ws.cell(2,1).value,str):  # fund name
                set_font(ws.cell(2,1), YELLOW, bold=True)
        if os.path.exists(LOGO):
            try:
                im=XLImage(LOGO); im.width=34; im.height=34; ws.add_image(im,'A1')
            except Exception: pass
    wb.save(outfile)
if __name__=='__main__':
    rebrand(sys.argv[1], sys.argv[2], sys.argv[3])
