import os
import sys

# api/index.py is the Vercel entrypoint and isn't part of a package, so import it
# by path the same way the platform does.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "api"))
