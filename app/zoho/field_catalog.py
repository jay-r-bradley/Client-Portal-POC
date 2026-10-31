"""Every Zoho CRM module and field the portal uses, with label, type and purpose.
Single source for docs/ZOHO_FIELDS.md and the admin console's field check.
API names come from settings, so an org that names a field differently only
changes .env."""

from __future__ import annotations

from ..config import Settings


def _f(api_name: str, label: str, type_: str, purpose: str, *, standard: bool, required: bool = False) -> dict:
    return {"apiName": api_name, "label": label, "type": type_, "purpose": purpose, "standard": standard, "required": required}


def field_catalog(settings: Settings) -> list[dict]:
    crm = settings.crm
    d, p, ref, signup = crm.deal, crm.property, crm.referral, crm.signup
    return [
        {
            "module": crm.contacts_module, "label": "Contacts", "kind": "Standard module",
            "purpose": "The client. One client login is linked to one Contact, and only once they have an active deal.",
            "fields": [
                _f("First_Name", "First Name", "Single line", "Greeting on the dashboard", standard=True),
                _f("Last_Name", "Last Name", "Single line", "Client name", standard=True, required=True),
                _f("Email", "Email", "Email", "Matches the portal login to this Contact", standard=True, required=True),
                _f("Phone", "Phone", "Phone", "Shown on the client profile", standard=True),
                _f("Mobile", "Mobile", "Phone", "Used when Phone is empty", standard=True),
                _f("Owner", "Contact Owner", "User lookup", "The client's agent (name, email, phone in the portal)", standard=True, required=True),
            ],
        },
        {
            "module": crm.deals_module, "label": "Deals", "kind": "Standard module",
            "purpose": "The client's purchases, leases and offers. An open deal is what gives a client portal access.",
            "fields": [
                _f(d.name, "Deal Name", "Single line", "Deal title", standard=True, required=True),
                _f(d.stage, "Stage", "Picklist", "Pipeline status and progress tracker. Stage order comes from the picklist.", standard=True, required=True),
                _f(d.amount, "Amount", "Currency", "Deal amount", standard=True),
                _f(d.closing_date, "Closing Date", "Date", "Target closing date and AI timing insights", standard=True),
                _f(d.contact, "Contact Name", "Lookup (Contacts)", "Links the deal to the client. Clients only ever see deals linked to them.", standard=True, required=True),
                _f(d.type, "Type", "Picklist", "e.g. Purchase, Lease", standard=True),
                _f(d.description, "Description", "Multi-line", "Shown to the client as the agent's \"Latest update\". Keep it client-friendly.", standard=True),
                _f(d.property, "Property", "Lookup (Properties)", "The listing the deal is about", standard=False),
                _f("Owner", "Deal Owner", "User lookup", "Agent for messages about this deal", standard=True),
            ],
        },
        {
            "module": crm.properties_module, "label": "Properties", "kind": "Custom module (create it)",
            "purpose": "The brokerage's listings, used for search, the AI matcher and the featured showcase.",
            "fields": [
                _f(p.name, "Property Name", "Single line (module name field)", "Listing title", standard=True, required=True),
                _f(p.address, "Address", "Single line", "Street address", standard=False),
                _f(p.city, "City", "Single line", "Location filter in search", standard=False, required=True),
                _f(p.price, "Price", "Currency", "Budget filter. Rentals: monthly rent.", standard=False, required=True),
                _f(p.type, "Property Type", "Picklist", "e.g. Single Family, Condo, Townhouse, Land. Values become the \"Home type\" filter.", standard=False),
                _f(p.listing_type, "Listing Type", "Picklist (Sale, Rent)", "Buy / Rent filter", standard=False, required=True),
                _f(p.bedrooms, "Bedrooms", "Number", "Beds filter", standard=False),
                _f(p.bathrooms, "Bathrooms", "Decimal", "Bathrooms filter", standard=False),
                _f(p.floor_area, "Floor Area", "Number (sq ft)", "Floor area filter", standard=False),
                _f(p.status, "Status", f'Picklist (must include "{crm.available_status}")', "Only listings with this status are shown", standard=False, required=True),
                _f(p.description, "Description", "Multi-line", "Listing details; also read by AI search", standard=False),
                _f(p.photo_url, "Photo URL", "URL (https)", "Main photo on cards and the property page", standard=False),
                _f(p.featured, "Featured", "Checkbox", "Shows the listing in the \"Featured & newly acquired\" showcase", standard=False),
                _f(p.listed_date, "Listed Date", "Date", "Acquisition / listing date: showcase order and \"New\" badge (30 days)", standard=False),
            ],
        },
        {
            "module": crm.leads_module, "label": "Leads", "kind": "Standard module",
            "purpose": "Guest sign-ups (hot leads) and client referrals. Each becomes a Lead.",
            "fields": [
                _f("First_Name", "First Name", "Single line", "Guest or referred person's first name", standard=True),
                _f("Last_Name", "Last Name", "Single line", "Guest or referred person's last name", standard=True, required=True),
                _f("Email", "Email", "Email", "Contact details", standard=True),
                _f("Phone", "Phone", "Phone", "Contact details", standard=True),
                _f("Lead_Source", "Lead Source", f'Picklist (add "{signup.lead_source}" and "{ref.lead_source}")', "Marks portal sign-ups and client referrals", standard=True, required=True),
                _f("Lead_Status", "Lead Status", "Picklist", "Referral progress shown to the referring client", standard=True, required=True),
                _f(signup.criteria_field, "Portal Match Criteria", "Multi-line", "What a guest is searching for (budget, locations, bedrooms), kept current", standard=False),
                _f(ref.referred_by_field, "Referred By", "Lookup (Contacts)", "Links a referral to the client who referred them", standard=False, required=True),
                _f(ref.interest_field, "Inquiry Type", "Picklist (Buying a home, Land or a lot, Selling a property, Renting, Investment property)", "What the referred person is looking for", standard=False),
                _f("Description", "Description", "Multi-line", "Sign-up summary or the client's referral notes", standard=True),
                _f("Owner", "Lead Owner", "User lookup", "Referrals: the referring client's agent. Sign-ups: CRM_SIGNUP_LEAD_OWNER_ID or Zoho's assignment rules.", standard=True),
            ],
        },
        {
            "module": "Notes", "label": "Notes", "kind": "Standard module",
            "purpose": f'Client messages are saved as Notes titled "{crm.portal_note_prefix} …". Agents reply with a Note titled "{crm.portal_reply_prefix} …". No new fields needed.',
            "fields": [],
        },
        {
            "module": "Tasks", "label": "Tasks", "kind": "Standard module",
            "purpose": "Each client message creates a high-priority Task for the agent. No new fields needed.",
            "fields": [],
        },
    ]
