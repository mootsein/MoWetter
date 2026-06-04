import unittest

from fastapi import HTTPException

from app.main import app, validate_lat_lon


class ValidationTests(unittest.TestCase):
    def test_validate_lat_lon_accepts_valid_values(self):
        self.assertEqual(validate_lat_lon("52.1", "12.9"), (52.1, 12.9))

    def test_validate_lat_lon_rejects_out_of_range_values(self):
        with self.assertRaises(HTTPException) as ctx:
            validate_lat_lon(999, 12.9)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_validate_lat_lon_rejects_non_finite_values(self):
        with self.assertRaises(HTTPException) as ctx:
            validate_lat_lon("nan", 12.9)
        self.assertEqual(ctx.exception.status_code, 400)


class AppConfigurationTests(unittest.TestCase):
    def test_api_docs_are_disabled_by_default(self):
        paths = {route.path for route in app.routes}
        self.assertNotIn("/docs", paths)
        self.assertNotIn("/redoc", paths)
        self.assertNotIn("/openapi.json", paths)

    def test_readiness_route_exists(self):
        paths = {route.path for route in app.routes}
        self.assertIn("/api/ready", paths)


if __name__ == "__main__":
    unittest.main()
