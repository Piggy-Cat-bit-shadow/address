import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile


MODULE_PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "spain-catastro-export.py"
SPEC = importlib.util.spec_from_file_location("spain_catastro_export", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


AD_HEADER = """<?xml version="1.0" encoding="UTF-8"?>
<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2"
 xmlns:AD="urn:x-inspire:specification:gmlas:Addresses:3.0"
 xmlns:base="urn:x-inspire:specification:gmlas:BaseTypes:3.2"
 xmlns:GN="urn:x-inspire:specification:gmlas:GeographicalNames:3.0"
 xmlns:xlink="http://www.w3.org/1999/xlink">"""


def address(local_id="28.900.1.10.1234567AB1234C", reference="1234567AB1234C", number="10"):
    return f"""<gml:featureMember><AD:Address gml:id="ES.SDGC.AD.{local_id}">
      <AD:inspireId><base:Identifier><base:localId>{local_id}</base:localId></base:Identifier></AD:inspireId>
      <AD:position><AD:GeographicPosition><AD:geometry><gml:Point srsName="urn:ogc:def:crs:EPSG::25830"><gml:pos>440290 4474250</gml:pos></gml:Point></AD:geometry></AD:GeographicPosition></AD:position>
      <AD:locator><AD:AddressLocator><AD:designator><AD:LocatorDesignator><AD:designator>{number}</AD:designator></AD:LocatorDesignator></AD:designator></AD:AddressLocator></AD:locator>
      <AD:component xlink:href="#ES.SDGC.PD.28.900.28001"/><AD:component xlink:href="#ES.SDGC.TN.28.900.1"/><AD:component xlink:href="#ES.SDGC.AU.28.900"/>
    </AD:Address></gml:featureMember>"""


def definitions(language="esp", postcode="28001", municipality="MADRID"):
    return f"""
    <gml:featureMember><AD:ThoroughfareName gml:id="ES.SDGC.TN.28.900.1"><AD:name><AD:ThoroughfareNameValue><AD:name><GN:GeographicalName><GN:language>{language}</GN:language><GN:spelling><GN:SpellingOfName><GN:text>CL MAYOR</GN:text></GN:SpellingOfName></GN:spelling></GN:GeographicalName></AD:name></AD:ThoroughfareNameValue></AD:name></AD:ThoroughfareName></gml:featureMember>
    <gml:featureMember><AD:PostalDescriptor gml:id="ES.SDGC.PD.28.900.28001"><AD:postName><GN:GeographicalName><GN:language>{language}</GN:language></GN:GeographicalName></AD:postName><AD:postCode>{postcode}</AD:postCode></AD:PostalDescriptor></gml:featureMember>
    <gml:featureMember><AD:AdminUnitName gml:id="ES.SDGC.AU.28.900"><AD:name><GN:GeographicalName><GN:language>{language}</GN:language><GN:spelling><GN:SpellingOfName><GN:text>{municipality}</GN:text></GN:SpellingOfName></GN:spelling></GN:GeographicalName></AD:name></AD:AdminUnitName></gml:featureMember>"""


def building(reference="1234567AB1234C", use="1_residential", dwellings="2"):
    return f"""<gml:featureMember><bu:Building gml:id="ES.SDGC.BU.{reference}">
      <core:externalReference><core:ExternalReference><core:reference>{reference}</core:reference></core:ExternalReference></core:externalReference>
      <bu:currentUse>{use}</bu:currentUse><bu:numberOfDwellings>{dwellings}</bu:numberOfDwellings>
    </bu:Building></gml:featureMember>"""


def make_archives(directory, addresses, buildings, language="esp", postcode="28001", municipality="MADRID"):
    ad_path = pathlib.Path(directory) / "ad.zip"
    bu_path = pathlib.Path(directory) / "bu.zip"
    ad_xml = AD_HEADER + "".join(addresses) + definitions(language, postcode, municipality) + "</gml:FeatureCollection>"
    bu_xml = """<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:bu="http://inspire.jrc.ec.europa.eu/schemas/bu-ext2d/2.0" xmlns:core="http://inspire.jrc.ec.europa.eu/schemas/bu-core2d/2.0">""" + "".join(buildings) + "</gml:FeatureCollection>"
    with zipfile.ZipFile(ad_path, "w") as archive:
        archive.writestr("A.ES.SDGC.AD.28900.gml", ad_xml)
    with zipfile.ZipFile(bu_path, "w") as archive:
        archive.writestr("A.ES.SDGC.BU.28900.building.gml", bu_xml)
    return ad_path, bu_path


class SpainCatastroExportTests(unittest.TestCase):
    def test_utm30_conversion_matches_madrid(self):
        longitude, latitude = MODULE.utm30_to_wgs84(440290, 4474250)
        self.assertAlmostEqual(longitude, -3.705, places=2)
        self.assertAlmostEqual(latitude, 40.42, places=2)

    def test_exports_only_address_joined_to_strict_residential_building(self):
        with tempfile.TemporaryDirectory() as directory:
            ad_path, bu_path = make_archives(directory, [
                address(), address("28.900.1.11.7654321AB1234C", "7654321AB1234C", "11")
            ], [building(), building("7654321AB1234C", "2_agriculture", "1")])
            output = pathlib.Path(directory) / "output.jsonl"
            result = MODULE.export(ad_path, bu_path, output, 20, "Comunidad de Madrid", "ES-MD", "Madrid", "28900")
            records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(result["accepted"], 1)
            self.assertEqual(records[0]["residential_building_id"], "catastro-building:1234567AB1234C")
            self.assertEqual(records[0]["source_language"], "esp")
            self.assertEqual(records[0]["postcode"], "28001")

    def test_rejects_non_spanish_names_bad_postcode_and_no_number(self):
        cases = [
            {"language": "eng"},
            {"postcode": "2800"},
            {"addresses": [address(number="SN")]},
        ]
        for values in cases:
            with self.subTest(values=values), tempfile.TemporaryDirectory() as directory:
                ad_path, bu_path = make_archives(directory, values.get("addresses", [address()]), [building()],
                    values.get("language", "esp"), values.get("postcode", "28001"))
                output = pathlib.Path(directory) / "output.jsonl"
                result = MODULE.export(ad_path, bu_path, output, 20, "Comunidad de Madrid", "ES-MD", "Madrid", "28900")
                self.assertEqual(result["accepted"], 0)

    def test_deterministic_hard_cap(self):
        addresses = [address(f"28.900.1.{number}.{number:07d}AB1234C", f"{number:07d}AB1234C", str(number))
                     for number in range(1, 6)]
        buildings = [building(f"{number:07d}AB1234C") for number in range(1, 6)]
        with tempfile.TemporaryDirectory() as directory:
            ad_path, bu_path = make_archives(directory, addresses, buildings)
            first = pathlib.Path(directory) / "first.jsonl"
            second = pathlib.Path(directory) / "second.jsonl"
            MODULE.export(ad_path, bu_path, first, 3, "Comunidad de Madrid", "ES-MD", "Madrid", "28900")
            MODULE.export(ad_path, bu_path, second, 3, "Comunidad de Madrid", "ES-MD", "Madrid", "28900")
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(len(first.read_text(encoding="utf-8").splitlines()), 3)


if __name__ == "__main__":
    unittest.main()
